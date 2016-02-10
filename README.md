# Overview

This project contains scripts that can be used to automatically find all the mongodb nodes in a cluster or replica set, and then fetch their log files to a single location. In other words it is a convenient tool for mongodb diagnostic work.

The ssh\_fetch\_mongodb\_logs.sh script requires SSH access to all the servers that the mongodb nodes reside on. **This script has no use without password-less SSH to all the hosts the mongodb nodes are on.** The ssh access could be setup permanently by using keypair management, or just enabled temporarily using sshpass.

## ssh\_fetch\_mongodb\_logs.sh usage

### Quickstart

```bash
./ssh\_fetch\_mongodb\_logs.sh mongos_host1:27017
```
