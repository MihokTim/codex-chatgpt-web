import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
const [mode, home, output] = process.argv.slice(2);
if (!["native", "web"].includes(mode!) || !home || !output) throw new Error("Usage: verify-routing-probe.ts native|web HOME OUTPUT_DIR");
const readLines = (path: string) => readFileSync(path,"utf8").split("\n").filter(Boolean).map(line=>JSON.parse(line));
const normalize = (value: string) => value.replaceAll("\\_", "_");
const events = readLines(join(output,`${mode}.stdout.jsonl`));
if(events.some(e=>e.type === "turn.failed" || e.type === "error")) throw new Error("Probe contains an error event");
const root = events.find(e=>e.type === "thread.started")?.thread_id;
if(!root)throw new Error("Missing root id");
const children: string[] = [...new Set<string>(events.flatMap(e=>e.item?.receiver_thread_ids??[]))];
if(children.length !== (mode === "native" ? 1 : 2))throw new Error("Unexpected child count");
const files = [...new Bun.Glob("sessions/**/*.jsonl").scanSync({cwd:home,absolute:true})];
const sessions = [root,...children].map(id=>{
  const file=files.find(file=>file.includes(id));
  if(!file)throw new Error(`Missing session ${id}`);
  const records=readLines(file);
  const ctx=records.find(e=>e.type === "turn_context")?.payload;
  const end=records.filter(e=>e.type === "event_msg"&&e.payload?.type === "task_complete").at(-1)?.payload;
  if(!end?.last_agent_message || end.error)throw new Error(`Session did not complete: ${id}`);
  return {id,model:ctx?.model,effort:ctx?.effort,multiAgent:ctx?.multi_agent_version,final:normalize(end.last_agent_message),records};
});
const expectedModels = mode === "native" ? ["gpt-6-astra","gpt-6-astra"] : ["chatgpt-web/pro","chatgpt-web/extra-high","chatgpt-web/pro"];
const expectedEfforts = mode === "native" ? ["medium","medium"] : ["ultra","xhigh","ultra"];
for(const [i,s] of sessions.entries())if(s.model!==expectedModels[i]||s.effort!==expectedEfforts[i])throw new Error(`Unexpected routing at ${i}: ${s.model}/${s.effort}`);
const calls=sessions[0]!.records.filter(e=>e.type==="response_item"&&e.payload?.type==="function_call"&&e.payload?.name==="spawn_agent").map(e=>JSON.parse(e.payload.arguments));
if(mode === "native") {
  for(const record of sessions[0]!.records.filter(e=>e.type==="response_item"&&e.payload?.type==="custom_tool_call"&&e.payload?.name==="exec")) {
    const source=ts.createSourceFile("probe.js",record.payload.input,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
    const visit=(node:ts.Node):void=>{
      if(ts.isCallExpression(node)&&node.expression.getText(source).endsWith("__spawn_agent")){
        const arg=node.arguments[0];
        if(!arg||!ts.isObjectLiteralExpression(arg))throw new Error("Nonliteral probe spawn arguments");
        const keys=arg.properties.map(p=>{if(!ts.isPropertyAssignment(p))throw new Error("Dynamic probe spawn property");return p.name.getText(source);});
        calls.push(Object.fromEntries(keys.map(key=>[key,true])));
      }
      ts.forEachChild(node,visit);
    };
    visit(source);
  }
}
if(calls.length!==children.length)throw new Error("Unexpected spawn count");
if("model" in calls[0]||"reasoning_effort" in calls[0])throw new Error("Default-child probe did not omit model/effort");
if(mode==="web"&&(calls[1].model!=="chatgpt-web/pro"||calls[1].reasoning_effort!=="ultra"))throw new Error("Missing explicit Pro escalation");
const markers=mode==="native"?["NATIVE_ROUTING_OK","NATIVE_CHILD_OK"]:["WEB_ROUTING_OK","DEFAULT_WEB_CHILD_OK","ESCALATED_WEB_CHILD_OK"];
for(const [i,marker] of markers.entries())if(!sessions[i]!.final.includes(marker))throw new Error(`Missing marker ${marker}`);
console.log(JSON.stringify({mode,verified:true,defaultSpawnOmittedModelAndEffort:true,sessions:sessions.map(({records,...s})=>s)},null,2));