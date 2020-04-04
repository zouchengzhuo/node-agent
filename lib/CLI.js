/**
 * Tencent is pleased to support the open source community by making Tars available.
 *
 * Copyright (C) 2016THL A29 Limited, a Tencent company. All rights reserved.
 *
 * Licensed under the BSD 3-Clause License (the "License"); you may not use this file except 
 * in compliance with the License. You may obtain a copy of the License at
 *
 * https://opensource.org/licenses/BSD-3-Clause
 *
 * Unless required by applicable law or agreed to in writing, software distributed 
 * under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR 
 * CONDITIONS OF ANY KIND, either express or implied. See the License for the 
 * specific language governing permissions and limitations under the License.
 */

'use strict';

var path = require('path');
var util = require('util');
var cluster = require('cluster');
var os = require('os');

var compareVersions = require('compare-versions');

var God = require('./God');
var constants = require('./constants');
var convert = require('./util/convert');
var cpu = require('./util/cpu');
var deps = require('./util/lsdeps');
var Log = require('./log');
var pkg = require('../package.json');

var tarsReport = require('./tars/Report');
var tarsMessage = require('./tars/Message');
var tarsNotify = require('./tars/Notify');

var bindEvents = function() {
	var exception = false;
	//绑定cluster时间，在各个阶段输出日志，并重定向worker进程的日志输出
	cluster.on('fork', function(worker) {
		console.info('worker(%s), forked.', worker.process.pid);
	}).on('online', function(worker) {
		console.info('worker(%s), online.', worker.process.pid);
	}).on('listening', function(worker, address) {
		console.info('worker(%s), listening on %s:%s', worker.process.pid, address.address || '', address.port);
	}).on('fork', function(worker) {

		var procStd = function(pid, level) {
			return function(buf) {
				buf.toString().split('\n').forEach(function(line) {
					if (line.length > 0) {
						if (line[line.length - 1] === '\r') {
							line = line.slice(0, -1);
						}

						Log.append(null, {
							level : level,
							msg : line,
							meta : {
								pid : pid
							}
						});
					}
				});
			};
		};

		if (Log.isLogToFile()) {
			worker.process.stdout.on('data', procStd(worker.process.pid, 'info'));
			worker.process.stderr.on('data', procStd(worker.process.pid, 'error'));
		} else {
			worker.process.stdout.pipe(process.stdout);
			worker.process.stderr.pipe(process.stderr);
		}
	});
	//绑定God的 message 事件，打印，并向notify服务上报各种管理信息
	God.events.on('message', function(code, worker, args) {
		switch(code) {
			case constants.GOD_MESSAGE.EXCEPTION_REACHED_COND : {
				console.error('exception occurred more than %s times within %s seconds, exiting ...', constants.EXCEPTION_TOTAL, constants.EXCEPTION_TIME / 1000);
				tarsNotify.report.error(util.format('exiting,exception occurred more than %s times within %s seconds', constants.EXCEPTION_TOTAL, constants.EXCEPTION_TIME / 1000), '');
				exception = true;
				break;
			}
			case constants.GOD_MESSAGE.KILLING_ALL_WORKERS : {
				console.info('killing all worker process ...');
				tarsReport.destroy();
				tarsMessage.destroy();
				Log.close();
				break;
			}
			case constants.GOD_MESSAGE.KILLING_WORKER : {
				console.info('killing worker(%s) ...', worker.process.pid);
				break;
			}
			case constants.GOD_MESSAGE.FORCE_KILL_WORKER : {
				console.error('exceeded the graceful timeout, force kill worker(%s) ...', worker.process.pid);
				tarsNotify.report.error('exceeded the graceful timeout, force kill worker', worker.process.pid);
				break;
			}
			case constants.GOD_MESSAGE.ALL_WORKERS_STOPPED : {
				console.info('all workers killed, really exiting now ...');
				setTimeout(function() {
					process.exit(exception ? constants.CODE_UNCAUGHTEXCEPTION : 0);
				}, 100).unref();
				break;
			}
			case constants.GOD_MESSAGE.STOP_ZOMBIE_WORKER : {
				console.error('detected zombie worker(%s).', worker.process.pid);
				tarsNotify.report.error('detected zombie worker.', worker.process.pid);
				break;
			}
			case constants.GOD_MESSAGE.KILL_ERROR : {
				console.error('kill worker(%s) failed, %s.', worker.process.pid, args || 'no error');
				tarsNotify.report.error('kill worker failed', worker.process.pid);
				break;
			}
		}
	}).on('exit', function(worker, error, code, signal) {
		if (error) {
			console.error('worker(%s), exit unexpected.', worker.process.pid);
			tarsNotify.report.error('worker exit unexpected', worker.process.pid);

			if (typeof error === 'string') {
				Log.append(null, {
					level : 'error',
					msg : error,
					meta : {
						pid : worker.process.pid
					}
				});
			}
		} else {
			console.info('worker(%s), exit normally%s.', worker.process.pid, convert.friendlyExit(code, signal, ' with'));
		}
	});
	//Ctrl-C手动退出事件
	process.once('SIGINT', function() {
		console.info('received kill or Ctrl-C signal.');
		tarsNotify.report.info('stop');
		God.killAll();
	}).on('exit', function(code) {
		console.info('exit%s.', convert.friendlyExit(code, null, ' with'));
	});
	//绑定tars平台消息通知事件，把消息下发给worker进程，或者杀死worker进程
	tarsMessage.on('notify', function(command, data, callback) {
		var mesgObj = {
			cmd : command
		};

		if (data) {
			mesgObj.data = data;
		}

		// send to worker
		God.send(mesgObj);

		// send to master(itself)
		mesgObj.setRet = callback;
		process.emit('message', mesgObj); 
	}).on('shutdown', function() {
		console.info('received TARS shutdown signal.');
		tarsNotify.report.info('stop');
		God.killAll();
	});
	//监听进程消息
	process.on('message', function(message) {
		if (message) {
			switch (message.cmd) {
				//改变日志级别
				case 'tars.setloglevel' : {
					Log.setLevel(message.data, null);
					break;
				}
				//返回是否每个worker都起来了
				case 'preheatCheck' : {
					if (God.getStatus().every(function (status) {
						return status === constants.WORKER_STATUS.ONLINE;
					})) {
						message.setRet('success');
					} else {
						message.setRet('not ready');
					}
					break;
				}
				//查看版本
				case 'tars.viewversion' : {
					message.setRet(pkg.version);
					break;
				}
			}
		}
	});
};

var initLog = function(name, dir) {
	Log.prepare(name, dir);

	Log.init(null, 'TarsRotate', {
		maxFiles : constants.APPLOG_MAX_FILES,
		maxSize : constants.APPLOG_MAX_SIZE
	});

	Log.init('agent', 'TarsRotate', {
		maxFiles : constants.APPLOG_MAX_FILES,
		maxSize : constants.APPLOG_MAX_SIZE
	});

	Log.setLevel(constants.APPLOG_LEVEL, null);
};

var outRedirect = function() {
	var register = function(level) {
		return function() {
			Log.append('agent', {
				level : level,
				msg : util.format.apply(util, arguments),
				meta : {
					pid : process.pid
				}
			});
		};
	};

	console.info = register('info');
	console.warn = register('warn');
	console.error = register('error');
};

var getWorkerArgs = function(script, opts) {
	var args = {}, obj;
	//设置脚本路径
	args['script'] = script;
	//设置脚本选项，即如： node app.js --key1 v1 --key2 v2，其中的 --key1 v1 --key2 v2
	if (opts.scriptArgs) {
		args['script_args'] = opts.scriptArgs;
	}
	//设置nodejs启动选项，即如 node --inspect app.js，其中的 --inspect
	if (opts.nodeArgs) {
		args['node_args'] = opts.nodeArgs;
	}

	//worker process title
	//woerker进程名，如果选项中有name，则以name命名
	args['name'] = typeof opts.name === 'string' ? opts.name : path.basename(script, path.extname(script));

	//pass custom env to worker
	//worker的环境变量
	if (opts.env) {
		args['env'] = opts.env;
	}
	//http相关
	if (opts.httpAddress) {
		obj = convert.extractAddress(opts.httpAddress);
		if (obj) {
			args['http_ip'] = obj.ip;
			args['http_port'] = obj.port;
		}
	}

	//specify worker uid and gid, if not set it's equal to Master 
	//worker的用户/用户组
	if (opts.runAsUser) {
		args['run_as_user'] = opts.runAsUser;
	}
	if (opts.runAsGroup) {
		args['run_as_group'] = opts.runAsGroup;
	}

	//设置老生代最大内存（修改v8堆内存限制）
	if (!isNaN(opts.maxMemoryRestart)) {
		if (!Array.isArray(args['node_args'])) {
			args['node_args'] = [];
		}
		args['node_args'].push('--max-old-space-size=' + opts.maxMemoryRestart);
	}
	//tars模板配置文件地址
	if (opts.config) {
		args['config'] = opts.config;
	}
	//设置worker存活检测的间隔时间
	if (!isNaN(opts.keepaliveTime)) {
		args['keepaliveTime'] = opts.keepaliveTime;
	}

	//是否启动上报
	if (typeof opts.tarsMonitor === 'boolean') {
		args['tarsMonitor'] = opts.tarsMonitor;
	}

	//日志文件路径
	if (opts.log) {
		args['log'] = path.join(opts.log, args['name'].replace('.', '/') + '/');
	}

	return args;
};

var setConstants = function(opts) {
	//干掉worker进程时，优雅退出的时间
	if (!isNaN(opts.gracefulShutdown)) {
		//若选项中有，从选项中读取
		constants.GRACEFUL_TIMEOUT = opts.gracefulShutdown;
	}
	if (opts.config) {
		//如果有指定tars模板文件（意味着在tars环境下运行），退出时间若大于1秒则减去1秒，小于1秒则=0
		//TODO why？
		if (constants.GRACEFUL_TIMEOUT > 1000) {
			constants.GRACEFUL_TIMEOUT -= 1000;
		} else {
			constants.GRACEFUL_TIMEOUT = 0;
		}
	}
	//最大未捕获异常数量
	if (!isNaN(opts.exceptionMax)) {
		constants.EXCEPTION_TOTAL = opts.exceptionMax;
	}
	//最大未捕获异常时间窗口
	if (!isNaN(opts.exceptionTime)) {
		constants.EXCEPTION_TIME = opts.exceptionTime;
	}
	//worker存活检测的间隔时间
	if (!isNaN(opts.keepaliveTime)) {
		constants.WORKER_DETECT_INTERVAL = opts.keepaliveTime;
	}
	//最大滚动日志数量
	if (!isNaN(opts.applogMaxFiles)) {
		constants.APPLOG_MAX_FILES = opts.applogMaxFiles;
	}
	//单个滚动日志最大大小
	if (!isNaN(opts.applogMaxSize)) {
		constants.APPLOG_MAX_SIZE = opts.applogMaxSize;
	}
	//日志级别
	if (opts.applogLevel) {
		constants.APPLOG_LEVEL = opts.applogLevel;
	}
	//是否启动监控上报
	if (typeof opts.tarsMonitor === 'boolean') {
		constants.TARS_MONITOR = opts.tarsMonitor;
	}
	//http监控，超过多少的返回码被当作异常上报，默认是400
	if (!isNaN(opts.tarsMonitorHttpThreshold)) {
		constants.TARS_MONITOR_HTTP_THRESHOLD = opts.tarsMonitorHttpThreshold;
	}
	//是否将pathname作为接口名上报，默认是
	if (typeof opts.tarsMonitorHttpSeppath === 'boolean') {
		constants.TARS_MONITOR_HTTP_SEPPATH = opts.tarsMonitorHttpSeppath;
	}
	//认为socket异常是错误
	if (typeof opts.tarsMonitorHttpSocketerr === 'boolean') {
		constants.TARS_MONITOR_HTTP_SOCKETERR = opts.tarsMonitorHttpSocketerr;
	}
	//启用longstack（异步异常堆栈跟踪）
	if (typeof opts.longStack === 'boolean') {
		constants.LONG_STACK = opts.longStack;
	}
	//异步异常堆栈跟踪时，仅打出用户代码的部分
	if (typeof opts.longStackFilterUsercode === 'boolean') {
		constants.LONG_STACK_FILTER_USERCODE = opts.longStackFilterUsercode;
	}
	//版本兼容判断
	if (constants.LONG_STACK && compareVersions(process.versions.node, '8.2.0') < 0) {
		constants.LONG_STACK = false;
	}

	if (!constants.LONG_STACK) {
		constants.LONG_STACK_FILTER_USERCODE = false;
	}
};

var initTarsComponent = function(args, opts) {
	//如果opts里有tarsnode endpoint地址，上报相关信息（一般部署在tars平台上，发布时生成的模板文件里边会有tarsnode endpoint地址）
	if (opts.tarsNode) {
		console.info('tars node:', opts.tarsNode);
		//传入进程名、tarsnode endpoint地址，配置文件地址，初始化调用tarsnode的rpc client对象
		tarsReport.init(args['name'], opts.tarsNode, opts.config);
		//向tarsnode上报node-agent的版本号，若没有node-agent版本好则上报nodejs的版本号
		tarsReport.reportVersion(pkg.version || process.version);
		//启动心跳上报，默认10秒向tarsnode发送一次rpc请求
		tarsReport.keepAlive();
	}

	if (opts.tarsLocal) {
		console.info('local interface:', opts.tarsLocal);
		//启动本地回环网卡的端口监听，用于收取tarsnode发过来的message，触发 shutdown / notify事件
		//一般端口与业务端口相同，网卡不同，用回环网卡，如业务使用端口8888，则此server监听127.0.0.1:8888
		tarsMessage.startServer(args['name'], opts.tarsLocal);
	}

	if (opts.config) {
		//如果有tars模板配置文件，初始化用于管理消息上报的notify rpc client
		tarsNotify.init(opts.config);
	}
};

var startWorker = function(opts) {
	var instances;
	//设置进程数量，如果有配置进程数量，则使用配置的进程数量
	//若没有进程数量，则用cpu物理核数量，若还是没有，用逻辑核数量
	if (!isNaN(opts.instances) && opts.instances > 0) {
		instances = opts.instances;
	} else {
		if (opts.instances === -1) { // instances = max
			instances = cpu.totalCores;
		} else { // instances = auto
			if (cpu.physicalCores > 0 && cpu.totalCores > cpu.physicalCores) { //physicalCores correct
				instances = cpu.physicalCores;
			} else {
				instances = cpu.totalCores;
			}
		}
	}

	instances = instances || 1;

	console.info('forking %s workers ...', instances);
	//启动n个worker进程
	God.startWorker(instances);
};

var deviceInfo = function() {
	if (cpu.physicalCores !== 0) {
		return util.format('%s arch, %d cpus, %d physical cores, %s platform, %s', os.arch(), cpu.totalCores, cpu.physicalCores, os.platform(), os.hostname());
	} else {
		return util.format('%s arch, %d cpus, %s platform, %s', os.arch(), cpu.totalCores, os.platform(), os.hostname());
	}
};

exports.start = function(script, opts) {
	//获取worker进程选项
	var args = getWorkerArgs(script, opts);
	//设置配置常量的值
	setConstants(opts);
	//设置进程名
	process.title = util.format('%s: master process', path.resolve(process.cwd(), script));
	//初始化滚动日志
	initLog(args['name'], args['log']);
	//重定向console输出到滚动日志中
	outRedirect();

	console.info('starting agent ...');
	console.info('node:', process.version);
	console.info('version:', 'v' + pkg.version);

	deps.list(function(err, depslist) {
		//读取并打印依赖模块及其版本列表
		if (!err) {
			console.info('dependencies:', depslist);
		}

		console.info('options:', util.inspect(args).replace(/[\n|\r]/g, ''));
		//判断系统平台，初始化读取cpu逻辑核数与物理核数
		cpu.init(function(err) {
			if (err) {
				console.warn('%s, fallback to use os.cpus()', err);
			}
			//输出平台架构，cpu核心，操作系统 主机名等数据
			console.info('device:', deviceInfo());
			//绑定各种事件，cluster fork进度、console重定向、平台管理notify事件、ctri+c退出事件、平台消息通知、master进程消息等
			bindEvents();
			//设置全局env属性、绑定cluaster的各种事件、启动worker进程心跳监控
			God.prepare(args);
			//初始化tars组件，连接tarsnode的client、接受消息的message rpc server、上报管理消息的notify
			initTarsComponent(args, opts);
			//启动worker进程
			startWorker(opts);
			//向notify输出restart消息
			tarsNotify.report.info('restart');
		});
	});
};