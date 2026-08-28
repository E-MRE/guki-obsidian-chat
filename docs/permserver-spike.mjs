// Minimal MCP stdio server exposing a permission_prompt tool.
// Logs every request so we can see EXACTLY what the CLI sends.
import fs from 'node:fs';
const log = m => fs.appendFileSync('permserver.log', JSON.stringify(m)+'\n');
const DECISION = process.env.PERM_DECISION || 'allow';
let buf='';
process.stdin.on('data', d => {
  buf += d.toString();
  const lines = buf.split('\n'); buf = lines.pop();
  for (const l of lines){
    if(!l.trim()) continue;
    let msg; try{ msg=JSON.parse(l) }catch{ continue }
    log({IN:msg});
    const send = r => { process.stdout.write(JSON.stringify(r)+'\n'); log({OUT:r}); };
    if (msg.method === 'initialize')
      send({jsonrpc:'2.0',id:msg.id,result:{protocolVersion:msg.params?.protocolVersion||'2024-11-05',
        capabilities:{tools:{}},serverInfo:{name:'permsrv',version:'1.0.0'}}});
    else if (msg.method === 'tools/list')
      send({jsonrpc:'2.0',id:msg.id,result:{tools:[{name:'permission_prompt',
        description:'Prompt the user to approve a tool call',
        inputSchema:{type:'object',properties:{tool_name:{type:'string'},input:{type:'object'},
          tool_use_id:{type:'string'},permission_suggestions:{type:'array'}}}}]}});
    else if (msg.method === 'tools/call'){
      const a = msg.params?.arguments || {};
      log({PERMISSION_REQUEST_ARGS:a});
      const payload = DECISION==='allow'
        ? {behavior:'allow', updatedInput: a.input}
        : {behavior:'deny', message:'User declined in Obsidian UI'};
      send({jsonrpc:'2.0',id:msg.id,result:{content:[{type:'text',text:JSON.stringify(payload)}]}});
    }
    else if (msg.method && msg.id!==undefined) send({jsonrpc:'2.0',id:msg.id,result:{}});
  }
});
