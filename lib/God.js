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

var cluster = require('cluster');
var path = require('path');

var treekill = require('./util/treekill');

var constants = require('./constants');

var EventEmitter = new require('events').EventEmitter;
var events = new EventEmitter();

var exception_count = 0, workers_seq = [];
var exception_timer, heartbeat_timer;

var env = {};

var allWorkers = function() {
	return Object.getOwnPropertyNames(cluster.workers).map(function(id) {
		return cluster.workers[id];
	});
};

var setCluster = function(args, execArgv) {
	//args: 脚本启动选项 execArgv： node启动选项
	var settings = {
		exec : path.resolve(path.dirname(module.filename), 'ProcessContainer.js'),
		silent : true
	};
	if (args) {
		settings.args = args;
	}
	if (execArgv) {
		settings.execArgv = execArgv;
	}
	//设置cluster.settings，包括：执行脚本、脚本参数、nodejs参数、worker进程io重定向到parent
	cluster.setupMaster(settings);
	//绑定worker退出事件
	cluster.on('exit', function(worker, code, signal) {
		//触发退出消息
		var error = false;
		//收到来自worker的god:err message时，给worker设置_hasError和_errMesg属性
		if (worker._hasError || code === constants.CODE_UNCAUGHTEXCEPTION) {
			error = true;
		}
		//会覆盖上面的 error = true
		if (worker._errMesg) {
			error = worker._errMesg;
		}

		events.emit('exit', worker, error, code, signal);
	}).on('exit', function(worker) {
		//判断是否杀死其它worker，或者重新拉起worker
		var exitedAfterDisconnect = typeof worker.exitedAfterDisconnect === 'boolean' ? worker.exitedAfterDisconnect : worker.suicide;

		workers_seq[worker._seq] = false;

		worker._status = constants.WORKER_STATUS.STOPPED;

		if (worker._timerId) {
			clearTimeout(worker._timerId);
			delete worker._timerId;
		}

		if (!exitedAfterDisconnect || worker._hasError) {
			switch(canStartWorker()) {
				case constants.CAN_START_WORKER.OK : {
					startWorker();
					break;
				}
				case constants.CAN_START_WORKER.NEED_TO_KILLALL : {
					killAll();
					break;
				}
			}
		}

		if (workers_seq.every(function (exists) {
			return exists !== true;
		})) {
			destroy();
		}
	}).on('online', function(worker) {
		//设置在线状态
		worker._status = constants.WORKER_STATUS.ONLINE;
	}).on('worker_message', function(worker, message) {
		//处理worker发送来的ipc消息
		var cmd = message.cmd, data = message.data, seq = null;

		if (typeof cmd !== 'string') {
			return;
		}
		//process.msg打头，发送消息
		if (cmd.indexOf('process.msg:') === 0) {
			seq = cmd.slice(12);
			//process.msg:all，这样的消息广播给所有worker进程
			if (seq === 'all') {
				allWorkers().forEach(function(worker) {
					worker.send(message);
				});
			} else {
				//process.msg:1，发送给seq为1的worker
				//TODO：worker咋知道有哪些seq？
				seq = parseInt(seq);
				if (!isNaN(seq)) {
					allWorkers().forEach(function(worker) {
						if (worker._seq === seq) {
							worker.send(message);
						}
					});
				}
			}
			return;
		}
		//其它命令
		//god:err 给worker设置_hasError和_errMesg属性
		//god:alive 更新worker的心跳时间
		switch(cmd) {
			case 'god:err' : {
				worker._hasError = true; 
				worker._errMesg = data;
				return;
			}
			case 'god:alive' : {
				worker._heartbeat = process.uptime();
				return;
			}
		}
	});
};

var setArgs = function(args) {
	if (args['env'] && typeof args['env'] === 'object') {
		env = args['env'];
	}

	env['agent_args'] = {};

	/*
	 * Private env - Main Script
	 */

	env['agent_args']['exec_script'] = path.resolve(process.cwd(), args['script']);

	/*
	 * Private env - Process Privilege
	 */

	if (args['run_as_user']) {
		env['agent_args']['process_user'] = args['run_as_user'];
	}

	if (args['run_as_group']) {
		env['agent_args']['process_group'] = args['run_as_group'];
	}

	/*
	 * Private env -  Heartbeat
	 */

	if (typeof args['keepaliveTime'] === 'number' && !isNaN(args['keepaliveTime'])) {
		env['agent_args']['process_keepalive'] = args['keepaliveTime'];
	}

	/*
	 * Private env - Logger Settings
	 */

	if (args['log'] && args['name']) {
		env['agent_args']['log_main'] = path.join(args['log'], args['name'] + '.log');
		env['agent_args']['log_maxsize'] = constants.APPLOG_MAX_SIZE;
		env['agent_args']['log_maxfiles'] = constants.APPLOG_MAX_FILES;
		env['agent_args']['log_level'] = constants.APPLOG_LEVEL;
	}

	/*
	 * Private env - HTTP Monitor Settings
	 */

	env['agent_args']['http_threshold'] = constants.TARS_MONITOR_HTTP_THRESHOLD;
	env['agent_args']['http_seppath'] = constants.TARS_MONITOR_HTTP_SEPPATH;
	env['agent_args']['http_socketerr'] = constants.TARS_MONITOR_HTTP_SOCKETERR;

	/*
	 * Private env - Long Stack
	 */
	env['agent_args']['long_stack'] = constants.LONG_STACK;
	env['agent_args']['stack_usercode'] = constants.LONG_STACK_FILTER_USERCODE;

	/*
	 * Private env - Reserved
	 */

	if (args['node_args']) {
		env['agent_args']['node_args'] = args['node_args'].join(',');
	}

	if (args['name']) {
		env['agent_args']['exec_name'] = args['name'];
	}

	// Object(agent_args) => JSON(agent_args)

	env['agent_args'] = JSON.stringify(env['agent_args']);

	/*
	 * Public env
	 */

	if (args['http_ip']) {
		env['HTTP_IP'] = args['http_ip'];
		env['IP'] = args['http_ip'];
	}

	if (args['http_port']) {
		env['HTTP_PORT'] = args['http_port'];
		env['PORT'] = args['http_port'];
	}

	if (args['config']) {
		env['TARS_CONFIG'] = args['config'];
	}

	if (typeof args['tarsMonitor'] === 'boolean') {
		env['TARS_MONITOR'] = args['tarsMonitor'];
	}
};

var setMonitor = function() {
	heartbeat_timer = setInterval(function() {
		var uptime = process.uptime();
		allWorkers().forEach(function(worker) {
			if (worker._status === constants.WORKER_STATUS.ONLINE && uptime - worker._heartbeat > constants.WORKER_DETECT_INTERVAL) {
				events.emit('message', constants.GOD_MESSAGE.STOP_ZOMBIE_WORKER, worker);
				stopWorker(worker, true);
			}
		});
	}, constants.WORKER_DETECT_INTERVAL * 1000);
};

var prepare = function(args) {
	//根据args设置全局的env对象的属性
	setArgs(args);
	//绑定cluster的各种事件
	setCluster(args['script_args'], args['node_args']);
	//定时检测worker的状态，若发现状态为online，但是心跳时间没更新超过限制，则认为是僵死进程，杀死该worker进程
	if (constants.WORKER_DETECT_INTERVAL > 0) {
		setMonitor();
	}
};

var startWorker = function(num) {
	var i = 0, seq = 0;

	num = num || 1;

	for (; i < num; i += 1) {
		//workers_seq里如果没有fasle，则seq是数组长度，并push一个true进去
		//如果有false，则将这个false改为true，seq就是这个false的位置
		//TODO 大概是为了保证worker顺序不变化？
		seq = workers_seq.indexOf(false);
		if (seq === -1) {
			seq = workers_seq.length;
			workers_seq.push(true);
		} else {
			workers_seq[seq] = true;
		}

		env['WORKER_ID'] = seq;
		//创建一个worker，WORKER_ID是seq
		//也就是worker进程的process.env中包含: HTTP_IP / HTTP_POTT（若是http协议）、TARS_CONFIG、TARS_MONITOR
		//还有个agent_args，是给node-agent用的，不是给worker进程用的
		(function(worker) {
			worker._status = constants.WORKER_STATUS.LAUNCHING;
			worker._heartbeat = process.uptime();
			worker._seq = seq;
			worker.once('error', function() {
				worker._status = constants.WORKER_STATUS.ERRORED;
			}).on('message', function(mesg) {
				//worker进程来消息了，直接转发给cluster的worker_message事件
				cluster.emit('worker_message', worker, mesg);
			});
		}(cluster.fork(env)));

		delete env['WORKER_ID'];
	}
};

var killWorker = function(worker) {
	treekill(worker.process.pid, 'SIGTERM', function(err) {
		if (err) {
			events.emit('message', constants.GOD_MESSAGE.KILL_ERROR, worker, err);
		}
	});
};

var stopWorker = function(worker, err) {
	if (worker._status === constants.WORKER_STATUS.LAUNCHING || worker._status === constants.WORKER_STATUS.ONLINE) {
		events.emit('message', constants.GOD_MESSAGE.KILLING_WORKER, worker);

		worker._status = constants.WORKER_STATUS.STOPPING;
		if (err) {
			worker._hasError = true;
		}

		if (constants.GRACEFUL_TIMEOUT === 0) {
			killWorker(worker);
			return;
		}

		worker._timerId = setTimeout(function() {
			events.emit('message', constants.GOD_MESSAGE.FORCE_KILL_WORKER, worker);
			delete worker._timerId;

			killWorker(worker);
		}, constants.GRACEFUL_TIMEOUT);

		try {
			worker.send({
				cmd : 'agent.shutdown'
			});
			worker.disconnect();
		} catch(e) {
			if (worker._timerId) {
				clearTimeout(worker._timerId);
				delete worker._timerId;
			}

			killWorker(worker);
		}
	}
};

var send = function(message) {
	allWorkers().forEach(function(worker) {
		try {
			worker.send(message);
		} catch(e) {}
	});
};

var killAll = function() {
	events.emit('message', constants.GOD_MESSAGE.KILLING_ALL_WORKERS);
	allWorkers().forEach(function(worker) {
		stopWorker(worker);
	});
};

var getStatus = function(worker) {
	if (worker) {
		return worker._status;
	}

	return allWorkers().map(function(worker) {
		return worker._status;
	});
};

var canStartWorker = function() {
	if (exception_count === 0) {
		exception_timer = setTimeout(function() {
			exception_count = 0;
			exception_timer = undefined;
		}, constants.EXCEPTION_TIME);
	}
	
	exception_count += 1;

	if (exception_count >= constants.EXCEPTION_TOTAL) {
		if (exception_timer) {
			clearTimeout(exception_timer);
			exception_timer = undefined;
		}

		if (exception_count === constants.EXCEPTION_TOTAL) {
			events.emit('message', constants.GOD_MESSAGE.EXCEPTION_REACHED_COND);
			return constants.CAN_START_WORKER.NEED_TO_KILLALL;
		}

		return constants.CAN_START_WORKER.ALREADY_SEND_CMD;
	}
	return constants.CAN_START_WORKER.OK;
};

var destroy = function() {
	if (heartbeat_timer) {
		clearInterval(heartbeat_timer);
		heartbeat_timer = undefined;
	}

	events.emit('message', constants.GOD_MESSAGE.ALL_WORKERS_STOPPED);
};

module.exports = {
	prepare : prepare,
	startWorker : startWorker,
	stopWorker : stopWorker,
	killAll : killAll,
	getStatus : getStatus,
	events : events,
	send : send
};