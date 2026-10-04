import assert from "node:assert/strict";
import {test} from "node:test";
import {availablePlugins, groupPlugins, pluginCategory, uniquePlugins} from "../desktop/plugins.ts";
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
