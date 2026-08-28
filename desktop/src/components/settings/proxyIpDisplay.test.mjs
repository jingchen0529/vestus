import assert from "node:assert/strict";
import test from "node:test";

import {
  getDirectConnectionStatus,
  getProxyIpDisplay,
} from "./proxyIpDisplay.ts";

test("does not present a stale proxy IP while configuration is being probed", () => {
  const previousConfig = {
    proxy_assigned: true,
    proxy_ip: "203.0.113.27",
  };

  assert.equal(getProxyIpDisplay(previousConfig, true, "ready"), "正在探测…");
  assert.equal(getProxyIpDisplay(previousConfig, false, "testing"), "正在探测…");
});

test("describes assigned, pending, and unassigned proxy IP states", () => {
  assert.equal(
    getProxyIpDisplay({ proxy_assigned: true, proxy_ip: "203.0.113.27" }, false, "ready"),
    "203.0.113.27",
  );
  assert.equal(
    getProxyIpDisplay({ proxy_assigned: true, proxy_ip: null }, false, "ready"),
    "等待探测",
  );
  assert.equal(getProxyIpDisplay(null, false, "unconfigured"), "—");
});

test("does not claim the direct connection is normal when IP probing failed", () => {
  assert.equal(getDirectConnectionStatus(null, true), "正在检测…");
  assert.equal(getDirectConnectionStatus("198.51.100.27", false), "直连正常");
  assert.equal(getDirectConnectionStatus("获取失败", false), "IP 获取失败");
  assert.equal(getDirectConnectionStatus(null, false), "等待检测");
});
