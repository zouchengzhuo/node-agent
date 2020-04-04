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

var path = require('path'),
	util = require('util');

var winston = require('winston'),
	winstonTars = require('@tars/winston-tars');

var constants = require('./constants');

//callsite模块，获取v8调用的文件名、函数名、行号
var callsite = require('callsite');

var httpStat = require('./tars/HttpStats');
var usageStat = require('./tars/UsageStats');
//获取进程环境变量中的agent_args，获取完后删掉（不暴露给业务代码）
var agent_args = JSON.parse(process.env.agent_args);
delete process.env.agent_args;
//执行脚本参数
var exec_script = agent_args.exec_script;

var logger, currLogLevel;
var longstack = null;

//获取文件名：行号
var lineno = function() {
	var stack = callsite()[2];
	return path.basename(stack.getFileName() || '<anonymous>') + ':' + stack.getLineNumber();
};

var errorToString = function(err) {
	if (typeof err === 'undefined') {
		return 'undefined';
	}

	if (typeof err !== 'object') {
		return err.toString();
	}

	if (!err) {
		return 'null';
	}

	return err.stack ? err.stack : err.toString();
};

// set constants
//设置上报给master的心跳间隔
if (parseInt(agent_args.process_keepalive) >= 0) {
	constants.WORKER_DETECT_INTERVAL = parseInt(agent_args.process_keepalive);
}

// [en|dis]able tars monitor
//是否启用monitor监控上报
if (!process.env.TARS_CONFIG) {
	constants.TARS_MONITOR = false;
} else if (process.env.TARS_MONITOR) {
	constants.TARS_MONITOR = (process.env.TARS_MONITOR === 'true');
}
process.env.TARS_MONITOR = constants.TARS_MONITOR;

// set process title
//进程名，文件名：worker process
if (exec_script) {
	process.title = util.format('%s: worker process', exec_script);
}

// fixed process script file path
// 设置argv的index 1为执行脚本
process.argv[1] = exec_script;

// if we've been told to run as a different user or group (e.g. because they have fewer
// privileges), switch to that user before importing any third party application code.
// 设置worker进程的用户组、用户
if (agent_args.process_group) {
  process.setgid(agent_args.process_group);
}

if (agent_args.process_user) {
  process.setuid(agent_args.process_user);
}

// Handle Ctrl+C signal
process.on('SIGINT', function() {});

// if script not listen on disconnect event, program will be exit
// worker进程与master进程的IPC通道断开连接时触发，执行一些清理操作
process.on('disconnect', function disconnect() {
	if (constants.TARS_MONITOR) {
		httpStat.unbind();
		usageStat.stop();
	}

	if (longstack !== null) {
		longstack.disable();
		longstack = null;
	}
	//没有其它disconnect的监听的话，就在此退出woerker进程
	if (!process.listeners('disconnect').filter(function(listener) {
		return listener !== disconnect;
	}).length) {
		process.removeListener('disconnect', disconnect);
		process.exit();
	}
});

// Notify master that an uncaughtException has been catched
//通知master进程，该worker有未捕获的异常
process.on('uncaughtException', function uncaughtListener(err) {
	//当只有这一个uncaughtException的监听时，退出进程并通知master进程，否则让其它的监听去处理
	if (!process.listeners('uncaughtException').filter(function (listener) {
		return listener !== uncaughtListener;
	}).length) {
		process.removeListener('uncaughtListener', uncaughtListener);
		try {
			process.send({
				cmd : 'god:err',
				data : errorToString(err)
			});
		} catch(e) {}
		setTimeout(function() {
			process.exit(constants.CODE_UNCAUGHTEXCEPTION);
		}, 100);
	}
});

// Main log settings
// 日志相关设置
if (!isNaN(parseInt(agent_args.log_maxsize))) {
	constants.APPLOG_MAX_SIZE = parseInt(agent_args.log_maxsize);
}
if (!isNaN(parseInt(agent_args.log_maxfiles))) {
	constants.APPLOG_MAX_FILES = parseInt(agent_args.log_maxfiles);
}
if (agent_args.log_level) {
	constants.APPLOG_LEVEL = agent_args.log_level;
}

// init logger
// 初始化滚动日志
if (agent_args.log_main) {
	logger = new (winston.Logger)({
		transports: [new (winston.transports.TarsRotate)({
			filename : agent_args.log_main,
			maxSize : constants.APPLOG_MAX_SIZE,
			maxFiles : constants.APPLOG_MAX_FILES
		})]
	});
} else {
	logger = new (winston.Logger)({
		transports : [new (winston.transports.Console)({
			formatter : winstonTars.Formatter.Detail()
		})]
	});
}

logger.setLevels(winston.config.tars.levels);
logger.emitErrs = true;

// Redirect console to master
//将console日志重定向给日志组件（启动时silent设置的true，日志组件中的io会被重定向给master）
console.log = function() {
	if (currLogLevel >= winston.config.tars.levels.debug) {
		var argsLen = arguments.length;
		var args = new Array(argsLen);
		for (var i = 0; i < argsLen; i += 1) {
			args[i] = arguments[i];
		}

		logger.log('debug', util.format.apply(util, args), {
			lineno : lineno()
		});
	}
};
console.info = function() {
	if (currLogLevel >= winston.config.tars.levels.info) {
		var argsLen = arguments.length;
		var args = new Array(argsLen);
		for (var i = 0; i < argsLen; i += 1) {
			args[i] = arguments[i];
		}

		logger.log('info', util.format.apply(util, args), {
			lineno : lineno()
		});
	}
};
console.warn = function() {
	if (currLogLevel >= winston.config.tars.levels.warn) {
		var argsLen = arguments.length;
		var args = new Array(argsLen);
		for (var i = 0; i < argsLen; i += 1) {
			args[i] = arguments[i];
		}

		logger.log('warn', util.format.apply(util, args), {
			lineno : lineno()
		});
	}
};
console.error = function() {
	if (currLogLevel >= winston.config.tars.levels.error) {
		var argsLen = arguments.length;
		var args = new Array(argsLen);
		for (var i = 0; i < argsLen; i += 1) {
			args[i] = arguments[i];
		}

		logger.log('error', util.format.apply(util, args), {
			lineno : lineno()
		});
	}
};

var setLevel = function(level) {
	if (typeof level !== 'string') {
		return;
	}
	level = level.toLowerCase();
	if (Object.getOwnPropertyNames(winston.config.tars.levels).indexOf(level) === -1) {
		return;
	}
	Object.getOwnPropertyNames(logger.transports).forEach(function(name) {
		logger.transports[name].level = level;
	});
	currLogLevel = winston.config.tars.levels[level];
};

setLevel(constants.APPLOG_LEVEL);

// process log level change
// 监听IPC消息，修改日志级别，或者退出worker进程
process.on('message', function(message) {
	if (message) {
		switch(message.cmd) {
			case 'tars.setloglevel' : {
				setLevel(message.data);
				break;
			}
			case 'agent.shutdown' : {
				if (process.connected) {
					process.disconnect();
				}
				break;
			}
		}
	}
});

// send heartbeat to master
// 定期给 master 进程发送心跳
// WORKER_DETECT_INTERVAL / 5，为发送心跳间隔，unref，避免退出进程时因这个timer而挂机进程
if (constants.WORKER_DETECT_INTERVAL > 0) {
	setInterval(function() {
		try {
			process.send({
				cmd : 'god:alive'
			}, undefined, function() {});
		} catch(e) {}
	}, Math.ceil(constants.WORKER_DETECT_INTERVAL * 1000 / constants.WORKER_HEART_BEAT_TIMES)).unref();
}

// monitor http & https svr
//如果需要监控上报，初始化http上报、用量上报
if (constants.TARS_MONITOR) {
	httpStat.bind({
		threshold : agent_args.http_threshold,
		sep : agent_args.http_seppath,
		socketerr : agent_args.http_socketerr
	});
	usageStat.start();
}

// Change dir to fix process.cwd
//设置工作目录到应用脚本路径
process.chdir(path.dirname(exec_script));

// Long Stack
// 启用longstack
if (agent_args.long_stack) {
	longstack = require('longstack');
	longstack.enable({
		'removeNativeCode' : agent_args.stack_usercode
	});
}

// Get the script & exec as main
//加载脚本并作为main文件执行
//参考 https://github.com/nodejs/node/blob/17f323ebfaf4b6f15e994412113d1e856a2e0ffc/lib/internal/modules/cjs/loader.js#L863
require('module')._load(exec_script, null, true);