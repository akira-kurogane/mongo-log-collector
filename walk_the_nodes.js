function walkNode(hp_addr, terminate) {
  /**
   * The walking algorithm:
   * invalid/dead conn -> return empty
   * terminate argument == true -> return this host's info and exit without doing any more potential recursion.
   * mongos conn -> finds the configsvrs, recurse to them but set terminate=true
   *             -> finds the shard connections strings, loop for each shard
   *                -> recurse to one node in each shard. (Try other nodes in a shard's replica set only if first one fails.)
   *             -> from config.mongos collection find all mongos nodes but set terminate=true
   * configsvr conn -> iterate shards and mongos nodes the same as the mongos conn, but give up on trying to determine other config servers
   * replset mongod conn -> recurse to all members in replset with terminate=true.
   * standalone mongod conn -> return this host's info, exit.
   */

  var r = []; //tuples of host info found
  var conn = new Mongo(hp_addr); //new mongodb connection
  if (!conn) {
    //print("*** Error - couldn't connect to \"" + hp_addr + "\"");
    return r;
  }
  var hi = {"external_hp": hp_addr, 
            "isMaster": conn.adminCommand({isMaster: 1}), 
            "serverStatus": conn.adminCommand({serverStatus: 1}),
            "parsedOpts": conn.adminCommand({getCmdLineOpts: 1}).parsed
           };
  var isRsNode = !!(hi.isMaster.setName);
  var isMongos = hi.serverStatus.process == "mongos";
  var isConfigSvr = hi.parsedOpts.sharding && hi.parsedOpts.sharding.clusterRole && 
        hi.parsedOpts.sharding.clusterRole == "configsvr";
  if (isRsNode) {
    hi.rsstatus = conn.adminCommand({replSetGetStatus: 1});
  }
  if (terminate) {
    r.push(hi);
  } else if (isRsNode) {
    hi.rsstatus.members.forEach(function(m) {
      walkNode(m.name, true).forEach(function(hi) { r.push(hi); }) //use terminate=true to stop circular walk between rs members
    });
  } else if (isMongos || isConfigSvr) {
    if (isMongos) {
      hi.parsedOpts.sharding.configDB.split(",").forEach(function(cfg_hp_addr) {
        walkNode(cfg_hp_addr, true).forEach(function(hi) { r.push(hi); }) //use terminate=true to stop config sv
      });
    }
    conn.getDB("config").shards.find().forEach(function(shd) {
      var hps = shd.host.substr(shd.host.indexOf("/") + 1).split(",");
      var r_len_before = r.length;
      while (hps.length && r.length == r_len_before) { //try all hosts until one successfully adds
        walkNode(hps.shift()).forEach(function(hi) { r.push(hi); }) //use terminate=!isMongos to walk shards if no mongos found
      }
    });
    var mongos_hps = [];
    conn.getDB("config").mongos.find().forEach(function(ms) { mongos_hps.push(ms._id); });
    if (isMongos && mongos_hps.length == 0) { //just in case above goes wrong
       mongos_hps.push(hp_addr);
    }
    mongos_hps.forEach(function(mongos_hp_addr) {
      walkNode(mongos_hp_addr, true).forEach(function(hi) { r.push(hi); }) //use terminate=true to stop loop
    });
  } else { //standalone node
    r.push(hi);
  }
  return r;
}

//Some debug printing out.
//all_hosts_info.forEach(function(hi) { print(hi.serverStatus.process  + "\t" + hi.serverStatus.host); } );

