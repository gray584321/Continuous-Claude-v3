var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});

// src/shared/redis-blackboard.ts
import { promisify } from "util";
import { tmpdir } from "os";
import { join } from "path";
var execSync = promisify(__require("child_process").execSync);
var RedisBlackboard = class {
  config;
  subprocess = null;
  messageBuffer = /* @__PURE__ */ new Map();
  constructor(config = { host: "localhost", port: 6379 }) {
    this.config = config;
  }
  /**
   * Publish message to channel
   */
  async publish(channel, message) {
    const cmd = [
      "redis-cli",
      "-h",
      this.config.host,
      "-p",
      this.config.port.toString(),
      "PUBLISH",
      channel,
      JSON.stringify(message)
    ].join(" ");
    try {
      const result = execSync(cmd, { encoding: "utf-8" });
      return parseInt(result.trim()) || 0;
    } catch {
      console.error(`Failed to publish to ${channel}`);
      return 0;
    }
  }
  /**
   * Subscribe to channel (blocking with timeout)
   */
  async subscribe(channel, timeoutMs = 5e3) {
    const tempFile = join(tmpdir(), `redis-sub-${Date.now()}.txt`);
    const cmd = [
      "redis-cli",
      "-h",
      this.config.host,
      "-p",
      this.config.port.toString(),
      "SUBSCRIBE",
      channel,
      "--pipe-timeout",
      (timeoutMs / 1e3).toString()
    ].join(" ");
    try {
      const result = execSync(
        `timeout ${timeoutMs}s redis-cli -h ${this.config.host} -p ${this.config.port} BLPOP ${channel} 2>/dev/null || echo "timeout"`,
        { encoding: "utf-8", timeout: timeoutMs + 1e3 }
      );
      if (result && !result.includes("timeout")) {
        return JSON.parse(result);
      }
    } catch {
      console.error(`Failed to subscribe to ${channel}`);
    }
    return null;
  }
  /**
   * Post to agent inbox
   */
  async postToAgent(agentId, message) {
    const fullMessage = {
      ...message,
      senderAgent: "system",
      timestamp: (/* @__PURE__ */ new Date()).toISOString()
    };
    await this.publish(`agent:${agentId}:inbox`, fullMessage);
  }
  /**
   * Broadcast to swarm
   */
  async broadcastToSwarm(swarmId, message) {
    const fullMessage = {
      ...message,
      senderAgent: "system",
      timestamp: (/* @__PURE__ */ new Date()).toISOString()
    };
    return await this.publish(`swarm:${swarmId}:events`, fullMessage);
  }
  /**
   * Get messages from buffer
   */
  getMessages(channel) {
    return this.messageBuffer.get(channel) || [];
  }
};
var CHANNELS = {
  AGENT_INBOX: (id) => `agent:${id}:inbox`,
  SWARM_EVENTS: (id) => `swarm:${id}:events`,
  SESSION_HEARTBEAT: (id) => `session:${id}:heartbeat`
};
var blackboard = new RedisBlackboard();
export {
  CHANNELS,
  RedisBlackboard,
  blackboard
};
