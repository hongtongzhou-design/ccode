import assert from "node:assert/strict";
import test from "node:test";
import {
  profileConnectionCaptions,
  showCatalogSyncAction,
} from "../src/profile-connection-ui.ts";

test("模型未同步只出一条完整说明，不再叠「目录模型失效」", () => {
  const parts = profileConnectionCaptions({
    connectionStatus: "model_unsynced",
    modelSyncStatus: "stale",
    modelSyncNote: "网关目录已标记历史失效：deepseek-v4-flash-0731",
  });
  assert.equal(parts.length, 1);
  assert.equal(
    parts[0]?.text,
    "网关目录已标记历史失效：deepseek-v4-flash-0731",
  );
  assert.equal(parts[0]?.cls, "text-warn-text");
});

test("目录过期才显示同步目录；模型未同步不显示", () => {
  assert.equal(
    showCatalogSyncAction({
      accountType: "api",
      gatewayId: "g1",
      connectionStatus: "catalog_stale",
    }),
    true,
  );
  assert.equal(
    showCatalogSyncAction({
      accountType: "api",
      gatewayId: "g1",
      connectionStatus: "model_unsynced",
    }),
    false,
  );
  assert.equal(
    showCatalogSyncAction({
      accountType: "official",
      gatewayId: "g1",
      connectionStatus: "catalog_stale",
    }),
    false,
  );
});
