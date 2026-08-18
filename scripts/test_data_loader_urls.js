#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const code = fs.readFileSync(path.join(__dirname, "..", "docs", "data-loader.js"), "utf8");

function loadLoader(documentLike) {
  const sandbox = {
    document: documentLike,
    window: {},
    URL,
    globalThis: {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.runInNewContext(code, sandbox);
  return sandbox.ProxyListData;
}

function scriptEl(attr, prop) {
  return {
    getAttribute: function (name) {
      return name === "src" ? attr : null;
    },
    src: prop || "",
  };
}

function sameList(actual, expected) {
  assert.deepStrictEqual(Array.from(actual || []), expected);
}

function run() {
  const relative = loadLoader({
    getElementsByTagName: function () {
      return [scriptEl("data-loader.js", "https://example.com/proxy-list/data-loader.js")];
    },
    baseURI: "https://example.com/proxy-list/",
  });
  assert.strictEqual(relative.listAssetBaseUrl(), "");
  sameList(relative.listAssetUrlCandidates("data.json", ""), ["data.json", "../data.json"]);
  sameList(relative.listAssetUrlCandidates("data.json", "../"), ["../data.json"]);

  const encodedAttr = loadLoader({
    getElementsByTagName: function () {
      return [scriptEl("/uv/service/abc123encoded", "https://yourworstnightmare1.github.io/proxy-list/data-loader.js")];
    },
    baseURI: "https://uv.example/uv/service/https://yourworstnightmare1.github.io/proxy-list/",
  });
  assert.strictEqual(
    encodedAttr.listAssetBaseUrl(),
    "https://yourworstnightmare1.github.io/proxy-list/"
  );
  const encodedCands = encodedAttr.listAssetUrlCandidates(
    "data.json",
    encodedAttr.listAssetBaseUrl()
  );
  assert.strictEqual(encodedCands[0], "data.json");
  assert.ok(encodedCands.indexOf("https://yourworstnightmare1.github.io/proxy-list/data.json") !== -1);

  const aboutPage = loadLoader({
    getElementsByTagName: function () {
      return [scriptEl("../data-loader.js", "https://example.com/proxy-list/data-loader.js")];
    },
    baseURI: "https://example.com/proxy-list/about/",
  });
  assert.strictEqual(aboutPage.listAssetBaseUrl(), "../");
  sameList(aboutPage.listAssetUrlCandidates("data.json", "../"), ["../data.json"]);

  const noScript = loadLoader({
    getElementsByTagName: function () {
      return [];
    },
    baseURI: "https://uv.example/",
  });
  assert.strictEqual(noScript.listAssetBaseUrl(), "");
  assert.ok(noScript.listAssetUrlCandidates("data.json", "").indexOf("/") === -1);

  assert.strictEqual(relative.isRelativeUrl("data.json"), true);
  assert.strictEqual(relative.isRelativeUrl("../data.json"), true);
  assert.strictEqual(relative.isRelativeUrl("https://example.com/x"), false);
  assert.strictEqual(relative.isRelativeUrl("//cdn.example/x"), false);
  assert.strictEqual(relative.directoryOfSrc("../data-loader.js"), "../");
  assert.strictEqual(relative.directoryOfSrc("data-loader.js"), "");

  console.log("ok");
}

run();
