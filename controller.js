
//collect_logs( { target: { all: true, host: [ "*" ], port: [ "*" ], shardName: [ "*" ], shard: true, mongos: true, configsvr: true, primary: true, secondary: true, arbiter: true }, time: "*" } )

collect_logs = function (options) {
	if (typeof options === "undefined") {
		options = {};
	}

	if (typeof options.target === "undefined") {
		options.target = { all: true };
	}

	if (typeof options.time === "undefined") {
		options.time = "all";
	}

	var validStringLabels = [ "host", "port", "shardName" ];
	var validBooleanLabels = [ "shard", "mongos", "configsvr", "primary", "secondary", "arbiter" ];

	if (options.target.mongos && (options.target.shard || options.target.configsvr || options.target.primary || options.target.secondary || options.target.arbiter) ) {
		// If you want mongos, you can't also ask for shard servers, or configsvrs, etc at the same time, because
		// a mongos can never also be a primary, or a configsvr, etc.
		throw "In { target: { ... } }, if mongos: true then cannot also specify any of shard: true, configsvr: true, primary: true, secondary: true, arbiter: true";
	}

	// What are we connected to?
	// The script ought to work equally well in any case.
	// The possible components are:
	//   - Sharded cluster, mongos
	//   - Sharded cluster, configsvr mongod
	//   - Sharded cluster, standalone shard mongod
	//   - Sharded cluster, replset shard mongod
	//   - Replica set, replset member mongod
	//   - Standalone mongod (this script not required, therefore this is out of scope)
	// This script needs to be run against:
	//   - If sharded cluster, then a mongos
	//   - If replica set, then a replset member

	var ismaster = db.isMaster();
	print("DEBUG: ismaster: " + tojson(ismaster));

	// sharded:
	//{
	//	"ismaster" : true,
	//	"msg" : "isdbgrid",
	//	"maxBsonObjectSize" : 16777216,
	//	"maxMessageSizeBytes" : 48000000,
	//	"maxWriteBatchSize" : 1000,
	//	"localTime" : ISODate("2016-01-04T05:01:12.036Z"),
	//	"maxWireVersion" : 3,
	//	"minWireVersion" : 0,
	//	"ok" : 1
	//}

	// replset:
	//{
	//	"setName" : "rubikrs",
	//	"setVersion" : 3,
	//	"ismaster" : true,
	//	"secondary" : false,
	//	"hosts" : [
	//		"ip-172-31-3-30:27001",
	//		"ip-172-31-3-31:27001",
	//		"ip-172-31-3-31.ap-southeast-2.compute.internal:27002"
	//	],
	//	"primary" : "ip-172-31-3-30:27001",
	//	"me" : "ip-172-31-3-30:27001",
	//	"electionId" : ObjectId("567e1ac34357d9b5b96c1685"),
	//	"maxBsonObjectSize" : 16777216,
	//	"maxMessageSizeBytes" : 48000000,
	//	"maxWriteBatchSize" : 1000,
	//	"localTime" : ISODate("2016-01-04T05:00:11.695Z"),
	//	"maxWireVersion" : 3,
	//	"minWireVersion" : 0,
	//	"ok" : 1,
	//	"$gleStats" : {
	//		"lastOpTime" : Timestamp(0, 0),
	//		"electionId" : ObjectId("567e1ac34357d9b5b96c1685")
	//	}
	//}


	var isSharded = (ismaster.msg === "isdbgrid");
	var isReplset = !!(ismaster.setName);
	print("DEBUG: isSharded = " + tojson(isSharded));
	print("DEBUG: isSharded = " + tojson(isReplset));
	assert(isSharded || isReplset, "Not connected to a mongos or replset member, aborting");
	assert( ! (isSharded && isReplset), "Somehow connected to both a mongos and a replset member... unexpected, aborting");


	// Figure out a map of the whole cluster.

	// The fields in the map are the criteria by which targets can be filtered.
	// Targets appear in multiple places, as relevant.
	// FIXME: this description is wrong and confusing.
	// Inside are sub-documents with fields that are the values that that filter might have.
	// The value for each sub-document field is an array of sub-documents, where each sub-document has the form { host: "hostname", port: "port" }
	// eg. a simple 4 member replset might look like:
	// {
	//     host : {
	//         "hosta" : {    // this is an object, but conceptually it's more like a set or array without dupes
	//             "hosta:27017" : 1,
	//             "hosta:27018" : 1,
	//             "hosta:27019" : 1
	//         },
	//         "hostb" : {
	//             "hostb:27017" : 1
	//         }
	//     },
	//     port : {
	//         "27017" : {
	//             "hosta:27017" : 1,
	//             "hostb:27017" : 1
	//         },
	//         "27018" : {
	//             "hosta:27018" : 1
	//         },
	//         "27019" : {
	//             "hosta:27019" : 1
	//         }
	//     },
	//     primary : {
	//         "hosta:27017" : 1
	//     },
	//     secondary : {
	//         "hosta:27018" : 1,
	//         "hostb:27017" : 1
	//     },
	//     arbiter : {
	//         "hosta:27019" : 1
	//     }
	// }
	var map = { };
	validStringLabels.forEach( function (label) {
		map[label] = {};
	} );
	validBooleanLabels.forEach( function (label) {
		map[label] = {};
	} );

	var addValueToMap = function (field, value, doc) {
		if ( ! (field in map) ) {
			map[field] = {};
		}
		if ( ! (value in map[field]) ) {
			map[field][value] = {};
		}
		//map[field][value].push(doc);
		map[field][value][doc] = 1;
	};

	var addLabelToMap = function (label, doc) {
		if ( ! (label in map) ) {
			map[label] = {};
		}
		//map[label].push(doc);
		map[label][doc] = 1;
	};

	var splitHostAndPort = function (hostAndPort) {
		var result = {};
		var colon = hostAndPort.indexOf(":");
		if (colon >= 0) {
			result.host = hostAndPort.substring(0, colon);
			result.port = hostAndPort.substring(colon + 1);
		} else {
			result.host = hostAndPort;
			result.port = "27017";
		}
		return result;
	};

	var addSingleToMap = function (hostAndPort, labels) {
		var split = splitHostAndPort(hostAndPort);
		//var doc = { host: host, port: port };
		//var doc = split;
		//var doc = hostAndPort;
		var doc = split.host + ":" + split.port;
		addValueToMap("host", split.host, doc);
		addValueToMap("port", split.port, doc);
		labels.forEach( function (label) {
			if (typeof label === "object") {
				for (var i in label) {
					label[i].forEach( function (v) {
						addValueToMap(i, v, doc);
					} );
				}
			} else {
				addLabelToMap(label, doc);
			}
		} );
	};

	var addToMap = function (hostAndPorts, labels) {
		hostAndPorts.forEach( function (hostAndPort) {
			addSingleToMap(hostAndPort, labels);
		} );
	};

	if (isSharded) {
		// Sharded cluster

		// Add myself.
		var ss = db.serverStatus();
		addSingleToMap(ss.host, [ "mongos" ]);

		// Add the other active mongoses.
		var getActiveMongoses = function () {
			var configDB = db.getSiblingDB("config");
			// Based on 3.2+ printShardingStatus
			// (most recently) active mongoses
			var mongosActiveThresholdMs = 60000;
			var mostRecentMongos = configDB.mongos.find().sort( { ping : -1 } ).limit(1);
			var mostRecentMongosTime = null;
			if (mostRecentMongos.hasNext()) {
				mostRecentMongosTime = mostRecentMongos.next().ping;
				// Mongoses older than the threshold are the most recent, but cannot be
				// considered "active" mongoses. (This is more likely to be an old(er)
				// configdb dump, or all the mongoses have been stopped.)
			}
			if (mostRecentMongosTime !== null) {
				var recentMongosQuery = {
					ping: {
						$gt: (function () {
							var d = mostRecentMongosTime;
							d.setTime(d.getTime() - mongosActiveThresholdMs);
							return d;
						} )()
					}
				};
				return configDB.mongos.find( recentMongosQuery, { _id: 1 } ).sort( { ping : -1 } ).toArray().map(function (x) { return x._id; });
			}
		};
		var activeMongoses = getActiveMongoses();
		print("DEBUG: active mongoses: " + tojson(activeMongoses));
		addToMap(activeMongoses, [ "mongos" ]);

		// Add the config server(s).
		var configsvrs = db.serverCmdLineOpts().parsed.sharding.configDB.split(",");
		print("DEBUG: configsvrs: " + tojson(configsvrs));
		addToMap(configsvrs, [ "configsvr" ]);

		// Add the shard servers.
		db.getSiblingDB("config").shards.find().forEach( function (shardDoc) {
			var shardName = shardDoc._id;
			var slash = shardDoc.host.indexOf("/");
			if (slash < 0) {
				// standalone shard
				addToMap( [ shardDoc.host ], [ "shard", { shardName: [ shardName ] } ]);
			} else {
				var replsetName = shardDoc.host.substring(0, slash);
				var replsetHosts = shardDoc.host.substring(slash + 1);
				// FIXME: primary/secondary/arbiter labels
				addToMap(replsetHosts.split(","), [ "shard", { shardName: [ shardName, replsetName ] } ]);
			}
		} );

	} else {
		// Replset
		// FIXME

		// Add myself.

		// Add the other replset members.

	}


	print("DEBUG: full map: " + tojson(map));


	// Filter the map components down so that only those which match the criteria we've been given are kept.
	// The filters cause targets to be removed.
	// If there are no filters, then logs from everything in the cluster are collected.

	var filteredMap = {};

	if (options.target.all) {

		// Just blindly copy all the hosts, and that's enough to be sure of getting everything.
		filteredMap.host = map.host;

	} else {

		var isAcceptableValue = function (value, filter) {
			if (typeof filter === "undefined") {
				//return true;
				return false;
			}
			if (typeof filter === "string") {
				// FIXME: glob
				return value === filter;
			}
			if (filter instanceof Array) {
				for (var i = 0; i < filter.length; i++) {
					// FIXME: glob
					if (value === filter[i]) {
						return true;
					}
				}
				return false;
			}
			throw "invalid type for filter: " + tojson(filter);
		};

		validStringLabels.forEach( function (label) {
			for (var labelValue in map[label]) {
				if (isAcceptableValue(labelValue, options.target[label])) {
					if (typeof filteredMap[label] === "undefined") {
						filteredMap[label] = {};
					}
					filteredMap[label][labelValue] = map[label][labelValue];
				}
			}
		} );

		validBooleanLabels.forEach( function (label) {
			if (typeof map[label] !== "undefined" && options.target[label]) {
				filteredMap[label] = map[label];
			}
		} );

	}

	print("DEBUG: filtered map: " + tojson(filteredMap));


	// For the places we need to collect logs from, identify the hostname and listening port of the process.
	// For each string label, we take the union of its sub-arrays.
	// Then for each label, we take the intersection of its sub-array.

	// eg. starting with:
	//  {
	//  	"host" : {
	//  		"ip-172-31-3-30" : {
	//  			"ip-172-31-3-30:37001" : 1,
	//  			"ip-172-31-3-30:37002" : 1,
	//  			"ip-172-31-3-30:27001" : 1
	//  		}
	//  	},
	//  	"port" : {
	//  		"32002" : {
	//  			"ip-172-31-3-31:32002" : 1
	//  		},
	//  		"37001" : {
	//  			"ip-172-31-3-30:37001" : 1
	//  		}
	//  	}
	//  }
	// we first "bubble up" to top-level arrays by unioning:
	// (only for the "string" labels, not the boolean ones)
	//  {
	//  	"host" : {
	//  		"ip-172-31-3-30:37001" : 1,
	//  		"ip-172-31-3-30:37002" : 1,
	//  		"ip-172-31-3-30:27001" : 1
	//  	},
	//  	"port" : {
	//  		"ip-172-31-3-31:32002" : 1,
	//  		"ip-172-31-3-30:37001" : 1
	//  	}
	//  }
	// and then take the intersection of the labels (and if there was "shard", "mongos", etc at this point, then we would intersect with those too):
	//  {
	//  	{ "host" : "ip-172-31-3-30", "port" : "37001" }
	//  }
	// and this is the list of things to get the logs from.

	var unionedMap = {};

	validStringLabels.forEach( function (label) {
		if (typeof filteredMap[label] !== "undefined") {
			unionedMap[label] = {};
			for (var labelValue in filteredMap[label]) {
				Object.extend(unionedMap[label], filteredMap[label][labelValue]);
			}
		}
	} );

	validBooleanLabels.forEach( function (label) {
		if (typeof filteredMap[label] !== "undefined") {
			unionedMap[label] = filteredMap[label];
		}
	} );

	print("DEBUG: unioned map: " + tojson(unionedMap));



	// If any of the unioned lists are empty, complain and give good feedback to the user.
	// (It means that the user has asked for something which it turns out does not exist.)
	// (eg. asking for configsvrs from a replset.)

	var foundEmpty = false;
	for (var label in unionedMap) {
		if (bsonWoCompare(unionedMap[label], {}) === 0) {
			var thing = {};
			thing[label] = options.target[label];
			print("ERROR: nothing matches target filter " + tojson(thing));
			foundEmpty = true;
		}
	}
	if (foundEmpty) {
		return;
	}


	// Now the intersecting.
	var intersection = undefined;
	var num = 1;
	for (var label in unionedMap) {
		if (typeof intersection === "undefined") {
			intersection = unionedMap[label];
			for (var value in intersection) {
				intersection[value] = num;
			}
		} else {
			// INTERSECT!
			for (var value in unionedMap[label]) {
				if (intersection[value]) {
					intersection[value]++;
				}
			}
			num++;
			for (var value in intersection) {
				if (intersection[value] < num) {
					delete intersection[value];
				}
			}
		}
	}

	print("DEBUG: intersection: " + tojson(intersection));


	// If the list is empty, then complain.
	if (bsonWoCompare(intersection, {}) === 0) {
		print("ERROR: nothing matches overall target filter " + tojson(options.target));
		return;
	}


	// For each target process, go to its host, run the script to get the logs, and suck them down.
	// Run "hostname" on the target (via ssh) and compare to db.serverStatus().host to confirm that we are where we think we should be.
	// Maybe also check the pid from serverStatus.

	for (var target in intersection) {
		var m = new Mongo(target);

		intersection[target] = splitHostAndPort(target);
		intersection[target].isMaster = m.adminCommand( { isMaster: 1 } );
		intersection[target].serverStatus = m.adminCommand( { serverStatus: 1 } );
		intersection[target].replSetGetStatus = m.adminCommand( { replSetGetStatus: 1 } );
		if (intersection[target].isMaster.msg !== "isdbgrid") {
			// Don't get this on mongoses.
			// They complain with { "$err" : "can't use 'local' database through mongos", "code" : 13644 }
			intersection[target].replSetConfig = m.getDB("local").getCollection("system.replset").findOne();
		}

		intersection[target].realHostname = splitHostAndPort(intersection[target].serverStatus.host).host;
		intersection[target].pid = intersection[target].serverStatus.pid;
	}

	print("DEBUG: intersection: " + tojson(intersection));

	print();
	print("Fetching logs from:");
	for (var target in intersection) {
		print("* host " + intersection[target].host + ", port " + intersection[target].port + ", pid " + intersection[target].pid);
		if (intersection[target].host !== intersection[target].realHostname) {
			print("  * WARNING: server claims to have hostname of " + intersection[target].realHostname);
		}
	}


	// FIXME: amalgamate going to each host just once (instead of once for each process, ie. possibly several times to the same host).
	for (var target in intersection) {
		print("-> fetching for: host " + intersection[target].host + ", port " + intersection[target].port + ", pid " + intersection[target].pid);
		//var rc = runProgram("ssh", intersection[target].host, "hostname");
		//if (rc !== 0) {
		//	print("Failed to check hostname! (" + rc + ")");
		//}
		var rc = runProgram("bash", "-c", "ssh " + intersection[target].host + " logcollector/collect_mongo_logs " + options.time.toString() + " " + intersection[target].port + " " + "> " + target + ".log");
		if (rc !== 0) {
			print("Failed to ssh! (" + rc + ")");
		}
	}

};

//collect_logs();
//collect_logs( { host: "foobar" } );
//collect_logs( { host: "ip-172-31-3-30" } );
//collect_logs( { host: "ip-172-31-3-30", port: [ "32002", "37001" ] } );
//collect_logs( { host: "ip-172-31-3-30", port: [ "32002", "37001" ], shardName: "rubikrs" } );
//collect_logs( { host: "ip-172-31-3-30", port: [ "32002", "37001" ], shardName: "rubikrs", mongos: true } );

//collect_logs( { target: { host: "ip-172-31-3-30", port: [ "32002", "37001" ], shardName: "rubikrs", mongos: true } } );
//collect_logs( { target: { host: "ip-172-31-3-30", port: [ "32002", "37001" ], mongos: true, configsvr: true } } );
//collect_logs( { target: { host: "ip-172-31-3-30", port: [ "32002", "37001" ], mongos: true, arbiter: true } } );
//collect_logs( { target: { host: "ip-172-31-3-30", port: [ "32002", "37001" ], shard: true, arbiter: true } } );

//collect_logs( { target: { host: "genique", port: [ "22222", "22226" ], shard: true, arbiter: true } } );
//collect_logs( { target: { host: "genique", port: [ "22222", "22226" ], shard: true } } );
//collect_logs( { target: { host: "genique", port: [ "22222" ], shard: true } } );
//collect_logs( { target: { host: "genique", port: [ "22225", "22226" ], shard: true } } );

//collect_logs( { target: { all: true } } );
//collect_logs();
//collect_logs( { time: "2016-01-05T18:08:" } );

collect_logs( { target: { host: "genique", port: [ "22222" ], mongos: true }, time: "2016-01-05T18:08:" } );

