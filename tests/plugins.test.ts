import assert from "node:assert/strict";
import {test} from "node:test";
import {availablePlugins, groupPlugins, pluginCategory, pluginUpdates, uniquePlugins} from "../desktop/plugins.ts";
import type {Plugin} from "../sdk/types.ts";

test("plugin categories deduplicate sources, retain updates and preserve installed capabilities", () => {
  const base = {version:"0.1.0",api_version:1,platforms:["all"]};
  const importer: Plugin = {...base,id:"import.pdf",name:"PDF import",format:{direction:"import",name:"PDF",extensions:["pdf"]},enabled:false,pending:true};
  const cbz: Plugin = {...base,id:"import.cbz",name:"CBZ import",format:{direction:"import",name:"CBZ",extensions:["cbz"]}};
  const exporter: Plugin = {...base,id:"export.pdf",name:"PDF export",format:{direction:"export",name:"PDF",extensions:["pdf"]}};
  const editor: Plugin = {...base,id:"editor",name:"Editor",ui:{entry:"editor.js",title:"Editor"}};
  const worker: Plugin = {...base,id:"worker",name:"Worker",workers:{"macos-arm64":"worker"}};
  const language: Plugin = {...base,id:"language",name:"繁體中文",language:{locale:"zh-Hant",name:"繁體中文",messages:"messages.json"}};
  const installed = [language,exporter,editor,importer,worker];
  const bundled = [cbz,importer,{...language,version:"0.2.0"},editor];
  const catalog = [{...cbz}, {...language,version:"0.3.0"}, {...exporter,version:"0.2.0",format:undefined}];
  const originals = structuredClone(installed);
  assert.deepEqual(groupPlugins(installed).map(group => [group.id,group.items.map(plugin => plugin.id)]),
    [["import",["import.pdf"]],["export",["export.pdf"]],["tools",["editor","worker"]],["language",["language"]]]);
  assert.deepEqual(groupPlugins([importer,cbz],"import")[0].items.map(plugin => plugin.id),["import.cbz","import.pdf"]);
  assert.deepEqual(groupPlugins(installed,"language")[0].items,[language]);
  assert.deepEqual(groupPlugins([],"export"),[]);
  assert.deepEqual(installed,originals,"sorting cannot mutate installed state");
  assert.deepEqual(availablePlugins(bundled,installed).map(plugin => [plugin.id,plugin.version]),
    [["import.cbz","0.1.0"],["language","0.2.0"]]);
  assert.deepEqual(availablePlugins(catalog,installed,bundled).map(plugin => [plugin.id,plugin.version]),
    [["language","0.3.0"],["export.pdf","0.2.0"]]);
  const known = uniquePlugins(catalog,bundled,installed);
  assert.equal(known.length,6,"updates and duplicates count once per plugin");
  assert.equal(pluginCategory(known.find(plugin => plugin.id === "export.pdf")!),"export",
    "installed capabilities take precedence over incomplete catalog metadata");
  assert.deepEqual(groupPlugins(availablePlugins(catalog,installed,bundled),"export",known)[0].items.map(plugin => plugin.id),
    ["export.pdf"],"an update with incomplete catalog metadata stays visible in its installed category");
  assert.equal(pluginCategory(worker),"tools");
  assert.equal(pluginCategory({...base,id:"unknown",name:"Other"}),"tools");
  assert.equal(pluginCategory(importer),"import","disabled or restart-pending plugins keep their category");
  assert.equal(groupPlugins(uniquePlugins(catalog,bundled,installed),"import")[0].items.length,2);
});

test("startup updates include only installed plugins and select the newest compatible version", () => {
  const plugin = (id: string, version: string): Plugin => ({id, name: id, version, api_version: 1, platforms: ["all"]});
  const installed = [
    {...plugin("epub", "0.1.3"), enabled: false}, plugin("editor", "0.1.10"),
    {...plugin("pending", "2.0.0"), active_version: "1.0.0", pending: true}, plugin("current", "1.0.0"),
  ];
  const bundled = [plugin("epub", "0.1.4"), plugin("editor", "0.1.9"), plugin("new", "1.0.0")];
  const catalog = [
    plugin("epub", "0.1.12"), plugin("epub", "0.1.4"), plugin("editor", "0.1.11"),
    plugin("pending", "2.0.0"), plugin("current", "0.9.9"), plugin("new", "2.0.0"),
    {...plugin("epub", "3.0.0"), api_version: 2}, plugin("current", "invalid"),
  ];
  const original = structuredClone([installed, bundled, catalog]);
  assert.deepEqual(pluginUpdates(installed, bundled, catalog).map(plugin => [plugin.id, plugin.version]),
    [["epub", "0.1.12"], ["editor", "0.1.11"]]);
  assert.deepEqual(pluginUpdates(installed, bundled).map(plugin => [plugin.id, plugin.version]),
    [["epub", "0.1.4"]], "included updates remain visible without a catalog");
  assert.deepEqual(pluginUpdates(installed, [plugin("current", "2.0.0")]).map(plugin => plugin.version), ["2.0.0"]);
  assert.deepEqual(pluginUpdates([plugin("large", "9007199254740992.0.0")],
    [plugin("large", "9007199254740993.0.0")]).map(plugin => plugin.version), ["9007199254740993.0.0"]);
  assert.deepEqual(availablePlugins(bundled, installed).map(plugin => [plugin.id, plugin.version]),
    [["epub", "0.1.4"], ["new", "1.0.0"]], "older included versions must not be offered as updates");
  assert.deepEqual(pluginUpdates([], bundled, catalog), [], "removed plugins are not update candidates");
  assert.deepEqual([installed, bundled, catalog], original, "checking must not change installed versions or activation");
});
