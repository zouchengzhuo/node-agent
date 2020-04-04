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

var http = require('http'),
	https = require('https'),
	assert = require('assert');
//on-finished模块，用于监听请求完成事件
var onFinished = require('on-finished');

var tarsMonitor = require('@tars/monitor').stat, 
	tarsConfigure = require('@tars/utils').Config;

var moduleName;
var slaveSetName, slaveSetArea, slaveSetID;
var createServer = {};
//从url中解析出pathname
var pathname = function(url) {
	var hash, qs, path;

	if (!url || typeof url !== 'string') {
		return '/';
	}

	if (url.indexOf('http://') === 0) {
		path = url.indexOf('/', 7);
	} else if (url.indexOf('https://') === 0) {
		path = url.indexOf('/', 8);
	}

	if (path !== undefined) {
		if (path !== -1) {
			url = url.slice(path);
		} else {
			return '/';
		}
	}

	hash = url.indexOf('#');

	if (hash !== -1) {
		url = url.slice(0, hash);
	}

	qs = url.indexOf('?');

	if (qs !== -1) {
		url = url.slice(0, qs);
	}

	return url || '/';
};
//初始化配置，得到moduleName，如Hello.HelloServer，或者 Hello.HelloServer.defaultsz1
var initConfig = function(obj) {
	var tarsConfig, setdivision;

	obj = obj || process.env.TARS_CONFIG;

	assert(obj, 'TARS_CONFIG is not in env and init argument is neither an Object nor a String.');

	if (typeof obj === 'string') {
		tarsConfig = new tarsConfigure;
		tarsConfig.parseFile(obj);
	} else {
		tarsConfig = obj;
	}
	//获取模块名，如：Hello.HelloServer，set信息
	moduleName = tarsConfig.get('tars.application.client.modulename') || 'NO_MODULE_NAME';
	setdivision = tarsConfig.get('tars.application.setdivision');

	if (tarsConfig.get('tars.application.enableset', '').toLowerCase() === 'y' && setdivision && typeof setdivision === 'string') {
		setdivision = setdivision.split('.');
		if (setdivision.length >= 3) {
			slaveSetName = setdivision[0];
			slaveSetArea = setdivision[1];
			slaveSetID = setdivision.slice(2).join('.');

			moduleName +=  '.' + slaveSetName + slaveSetArea + slaveSetID;
		}
	}
};

var onFinished_callback = function(err, res) {
	var reqInfo = res.__stat_req_info;
	//statusCode大于配置的阈值（默认为400）则上报异常，否则上报正常
	if ((reqInfo.socketerr && err) || (reqInfo.threshold !== 0 && res.statusCode >= reqInfo.threshold)) {
		tarsMonitor.report(reqInfo.report, tarsMonitor.TYPE.ERROR);
	} else {
		tarsMonitor.report(reqInfo.report, tarsMonitor.TYPE.SUCCESS, (process.uptime() - reqInfo.startTime) * 1000);
	}
};

//劫持 http/https.createServer，将requestListener替换为修改过的，以获取最终结果，做调用监控上报
var shimming = function(type, options) {
	switch (type) {
		case 'http' : {
			createServer[type] = createServer[type] || http.createServer;
			break;
		}
		case 'https' : {
			createServer[type] = createServer[type] || https.createServer;
			break;
		}
	}

	return function(/*...args*/) {
		var reqHandler = function(req, res) {
			var localInfo = req.socket.address();

			var reqInfo = {
				'report' : {
					'masterName' : type + '_client', //主调名，http_client / https_client
					'slaveName' : moduleName, //被调名，被调服务
					'interfaceName' : '', //接口名，暂时为空，后面赋值为请求路径
					'masterIp' :  req.socket.remoteAddress || '', //主调ip
					'slaveIp' : localInfo.address || '', //被调ip
					'slavePort' : localInfo.port || 0, //被调port
					'bFromClient' : false
				},
				'startTime' : process.uptime(), //请求时间
				'threshold' : options.threshold, //报错阈值
				'socketerr' : options.socketerr //socketerr是否上报异常
			};

			if (options.sep) {
				reqInfo.report.interfaceName = pathname(req.url);
			}
			//如果有set信息，添加上报set信息
			if (slaveSetName && slaveSetArea && slaveSetID) {
				reqInfo.report.slaveSetName = slaveSetName;
				reqInfo.report.slaveSetArea = slaveSetArea;
				reqInfo.report.slaveSetID = slaveSetID;
			}
			//向res中加入上报信息
			res.__stat_req_info = reqInfo;

			onFinished(res, onFinished_callback);

			/*
			 *	don't leak arguments to the other function
			 */
			var argsLen = arguments.length,
				args = new Array(argsLen);

			for (var i = 0; i < argsLen; i += 1) {
				args[i] = arguments[i];
			}

			requestListener && requestListener.apply(this, args);
		}, requestListener;

		switch (type) {
			case 'http' : {
				requestListener = arguments[0];
				return createServer[type].call(http, reqHandler);
			}
			case 'https' : {
				requestListener = arguments[1];
				return createServer[type].call(https, arguments[0], reqHandler);
			}
		}
	};
};

var restore = function(type) {
	if (!createServer[type]) {
		return;
	}

	switch (type) {
		case 'http' : {
			http.createServer = createServer[type];
			break;
		}
		case 'https' : {
			https.createServer = createServer[type];
			break;
		}
	}
	
	delete createServer[type];
};

exports.init = function(obj) {
	//初始化上报模块名
	initConfig(obj);
	//初始化monitor对象
	tarsMonitor.init(obj);
};
exports.bind = function(options) {
	var opt = {
		'threshold' : 400,
		'sep' : true,
		'socketerr' : true
	};
	//设置绑定选项
	if (options) {
		if (options.threshold >= 0) {
			opt.threshold = options.threshold;
		}
		if (typeof options.sep === 'boolean') {
			opt.sep = options.sep;
		}
		if (typeof options.socketerr === 'boolean') {
			opt.socketerr = options.socketerr;
		}
	}

	if (!moduleName) {
		exports.init();
	}
	//劫持createServer和createServer，加入上报模块
	http.createServer = shimming('http', opt);
	https.createServer = shimming('https', opt);
};
exports.unbind = function() {
	if (moduleName) {
		//恢复两种协议到原生的createServer，停止monitor上报
		restore('http');
		restore('https');

		tarsMonitor.stop();
	}
};