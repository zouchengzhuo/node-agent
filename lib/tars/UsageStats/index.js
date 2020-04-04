'use strict';

var assert = require('assert');
//event-loop-lag模块，用来统计主线程卡在eventloop中的时间， 其原理是用settimeout，回调真正执行的时间与设置的延时的差距，来表示eventloop中耗费的时间
//业务代码编写不当，或者机器cpu被吃满时，此特性会很高，此时要检查业务代码或者迁移机器
var lag = require('event-loop-lag');
var pidusage = require('pidusage');

var tarsMonitor = require('@tars/monitor').property;
var tarsConfigure = require('@tars/utils').Config;

var eventloop;

var moduleName;

var memTimerId, lagTimerId, cpuTimerId, libuvTimerId;

var rss, heapTotal, heapUsed, eventloopLag, cpuUsage, activeHandles, activeRequests;


//初始化上报模块信息
var initConfig = function(obj) {
	var tarsConfig, setdivision, slaveSetName, slaveSetArea, slaveSetID;

	obj = obj || process.env.TARS_CONFIG;

	assert(obj, 'TARS_CONFIG is not in env and init argument is neither an Object nor a String.');

	tarsMonitor.init(obj);

	if (typeof obj === 'string') {
		tarsConfig = new tarsConfigure;
		tarsConfig.parseFile(obj);
	} else {
		tarsConfig = obj;
	}

	moduleName = tarsConfig.get('tars.application.client.modulename', '');
	setdivision = tarsConfig.get('tars.application.setdivision');

	if (tarsConfig.get('tars.application.enableset', '').toLowerCase() === 'y' && setdivision && typeof setdivision === 'string') {
		setdivision = setdivision.split('.');
		if (setdivision.length >= 3) {
			slaveSetName = setdivision[0];
			slaveSetArea = setdivision[1];
			slaveSetID = setdivision.slice(2).join('.');
			if (moduleName.indexOf('.') !== -1) {
				moduleName = moduleName.slice(moduleName.indexOf('.') + 1);
			}
			moduleName = slaveSetName + slaveSetArea + slaveSetID + '.' + moduleName;
		}
	}
};

var initReporter = function() {
	// 常驻内存上报 最大/最小/平均
	rss = tarsMonitor.create(moduleName + '.rss', [new tarsMonitor.POLICY.Max, 
		new tarsMonitor.POLICY.Min,
		new tarsMonitor.POLICY.Avg]);
	//v8已经分配的堆内存总大小上报  最大/最小/平均
	heapTotal = tarsMonitor.create(moduleName + '.heapTotal', [new tarsMonitor.POLICY.Max, 
		new tarsMonitor.POLICY.Min,
		new tarsMonitor.POLICY.Avg]); 
	//已经使用的堆内存大小上报 最大/最小/平均
	heapUsed = tarsMonitor.create(moduleName + '.heapUsed', [new tarsMonitor.POLICY.Max, 
		new tarsMonitor.POLICY.Min,
		new tarsMonitor.POLICY.Avg]);
	//eventloop耗时上报 最大/最小/平均
	eventloopLag = tarsMonitor.create(moduleName + '.eventLoop', [new tarsMonitor.POLICY.Max, 
		new tarsMonitor.POLICY.Min,
		new tarsMonitor.POLICY.Avg]);
	//cpu用量百分比上报  最大/最小/平均
	cpuUsage = tarsMonitor.create(moduleName + '.cpuUsage', [new tarsMonitor.POLICY.Max, 
		new tarsMonitor.POLICY.Min,
		new tarsMonitor.POLICY.Avg]);
	//libuv activeHandles上报(libuv中active的句柄数)  最大/最小/平均
	activeHandles = tarsMonitor.create(moduleName + '.activeHandles', [new tarsMonitor.POLICY.Max, 
		new tarsMonitor.POLICY.Min,
		new tarsMonitor.POLICY.Avg]);
	//libuv activeRequests上报(libuv中active的http request数)  最大/最小/平均
	activeRequests = tarsMonitor.create(moduleName + '.activeRequests', [new tarsMonitor.POLICY.Max, 
		new tarsMonitor.POLICY.Min,
		new tarsMonitor.POLICY.Avg]);
};

//初始化eventloop耗时检测器
var initLag = function() {
	eventloop = lag(exports.lagInterval);
};
//上报cpu用量百分比
var reportCpu = function() {
	pidusage.stat(process.pid, function(err, stat) {
		if (!err) {
			cpuUsage.report(stat.cpu.toFixed(3));
		}
	});
};

//常驻内存、已分配/已使用堆内存上报
var reportMem = function() {
	var mem = process.memoryUsage();

	rss.report(mem.rss);
	heapTotal.report(mem.heapTotal);
	heapUsed.report(mem.heapUsed);
};
//eventloop耗时上报
var reportLag = function() {
	eventloopLag.report(eventloop().toFixed(3));
};
//libuv特性上报
var reportLibuv = function() {
	activeHandles.report(process._getActiveHandles().length);
	activeRequests.report(process._getActiveRequests().length);
};

exports.init = function(obj) {
	//初始化上报模块信息
	initConfig(obj);
	//初始化特性上报对象
	initReporter()
	//初始化eventloop耗时检查周期，默认每2秒检查一次
	initLag();
};

exports.start = function() {
	if (!rss) {
		exports.init();
	}

	if (!memTimerId) {
		memTimerId = setInterval(reportMem, exports.memInterval);
		memTimerId.unref();
	}

	if (!lagTimerId) {
		lagTimerId = setInterval(reportLag, exports.lagInterval);
		lagTimerId.unref();
	}

	if (!cpuTimerId) {
		cpuTimerId = setInterval(reportCpu, exports.cpuInterval);
		cpuTimerId.unref();
	}

	if (!libuvTimerId) {
		libuvTimerId = setInterval(reportLibuv, exports.libuvInterval);
		libuvTimerId.unref();
	}
};

exports.stop = function() {
	if (memTimerId) {
		clearInterval(memTimerId);
		memTimerId = undefined;
	}

	if (lagTimerId) {
		clearInterval(lagTimerId);
		lagTimerId = undefined;
	}

	if (cpuTimerId) {
		clearInterval(cpuTimerId);
		cpuTimerId = undefined;
	}

	pidusage.unmonitor(process.pid);

	if (libuvTimerId) {
		clearInterval(libuvTimerId);
		libuvTimerId = undefined;
	}
};

exports.lagInterval = 2 * 1000;
exports.memInterval = 5 * 1000;
exports.cpuInterval = 5 * 1000;
exports.libuvInterval = 10 * 1000;