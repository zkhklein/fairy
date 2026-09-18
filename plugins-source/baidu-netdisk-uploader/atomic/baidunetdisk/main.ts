/**
 * Baidu Netdisk upload wrapper (OAuth 2.0).
 *
 * Uses Baidu Netdisk Open Platform credentials (AppKey / SecretKey) with the
 * OAuth 2.0 authorization-code flow. Tokens (access_token + refresh_token) are
 * stored in a JSON file managed by the upload Node script, which also handles
 * automatic refresh when access_token expires (30-day validity).
 *
 * Because node.exe is a common process name, we launch via PowerShell and rely
 * on short fixed waits for the token-exchange step (fast, < 5s) and a longer
 * estimate for uploads.
 *
 * The inline Node.js scripts use only built-in fs/path/https.
 */
/* global hostApi, __hostEnv */

var DEFAULT_NODE = 'C:\\Program Files\\nodejs\\node.exe';
var POLL_INTERVAL_MS = 2000;
var MAX_WAIT_MS = 120 * 60 * 1000; // 120 minutes for large uploads

function _env() {
  return (typeof __hostEnv === 'object' && __hostEnv) ? __hostEnv : {};
}

/** Resolve fmb-data dir by walking up from the plugin's __filename (3 levels). */
function _fmbDataDir() {
  var f = typeof __filename === 'string' ? __filename : '';
  for (var i = 0; i < 3 && f; i++) {
    var bs = f.lastIndexOf('\\');
    var fs = f.lastIndexOf('/');
    var idx = Math.max(bs, fs);
    if (idx < 0) break;
    f = f.substring(0, idx);
  }
  return f;
}

async function _getNodePath() {
  var p = await hostApi.kv.get('config:nodePath');
  if (p && p.trim()) return p.trim();
  return DEFAULT_NODE;
}

/** Get PowerShell path. */
function _psPath() {
  var env = _env();
  var root = env['SystemRoot'] || env['windir'] || 'C:\\Windows';
  return root + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
}

/**
 * Build the Node script that exchanges an OAuth authorization code for
 * access_token + refresh_token and saves them to a JSON file.
 *
 * The script self-creates the token file's parent directory (a fresh install
 * has no workDir yet — writeFileSync would ENOENT and surface as a generic
 * 授权失败). It also POSTs the real outcome (including Baidu's error message)
 * back to the app plugin via the FMB HTTP API so the UI can show it.
 */
function buildExchangeScript(appKey, secretKey, code, tokenFile, callbackPluginId, requestId, fmbDataDir) {
  var AK = JSON.stringify(appKey);
  var SK = JSON.stringify(secretKey);
  var C = JSON.stringify(code);
  var F = JSON.stringify(tokenFile);
  var CID = JSON.stringify(callbackPluginId || '');
  var RID = JSON.stringify(requestId || '');
  var FDD = JSON.stringify(fmbDataDir || '');
  return [
    '(function(){',
    'var fs=require("fs"),path=require("path"),https=require("https");',
    'var appKey=' + AK + ',secretKey=' + SK + ',code=' + C + ',tokenFile=' + F + ',callbackPluginId=' + CID + ',requestId=' + RID + ',fmbDataDir=' + FDD + ';',
    'function postForm(host,path,form){',
    ' return new Promise(function(resolve,reject){',
    '  var body=Object.keys(form).map(function(k){return encodeURIComponent(k)+"="+encodeURIComponent(form[k])}).join("&");',
    '  var opt={hostname:host,path:path,method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded","Content-Length":Buffer.byteLength(body)}};',
    '  var req=https.request(opt,function(res){var d="";res.on("data",function(c){d+=c});res.on("end",function(){try{resolve(JSON.parse(d))}catch(e){reject(new Error("bad json: "+d))}})});',
    '  req.on("error",reject);req.write(body);req.end();',
    ' });',
    '}',
    'function httpPostJson(host,port,path,obj,token){',
    ' return new Promise(function(resolve,reject){',
    '  var body=JSON.stringify(obj);',
    '  var http=require("http");',
    '  var opt={hostname:host,port:port,path:path,method:"POST",headers:{"Content-Type":"application/json","Content-Length":Buffer.byteLength(body),"Authorization":"Bearer "+token}};',
    '  var req=http.request(opt,function(res){var d="";res.on("data",function(c){d+=c});res.on("end",function(){resolve({status:res.statusCode,body:d})})});',
    '  req.on("error",reject);req.write(body);req.end();',
    ' });',
    '}',
    'function findHttpMeta(){',
    '  if(process.env.FMB_HTTP_PORT && process.env.FMB_HTTP_TOKEN){return {port:parseInt(process.env.FMB_HTTP_PORT,10),token:process.env.FMB_HTTP_TOKEN};}',
    '  if(fmbDataDir){try{var m=path.join(fmbDataDir,"userData",".fmb-http.json");if(fs.existsSync(m)){return JSON.parse(fs.readFileSync(m,"utf8"))}}catch(_){}}',
    '  var cands=[path.join(process.env.LOCALAPPDATA||"","fairy-maid-brigade",".fmb-http.json"),path.join(process.env.APPDATA||"","fairy-maid-brigade",".fmb-http.json")];',
    '  for(var i=0;i<cands.length;i++){try{if(fs.existsSync(cands[i])){return JSON.parse(fs.readFileSync(cands[i],"utf8"))}}catch(_){}}',
    '  return null;',
    '}',
    'function callbackResult(ok,msg){',
    '  if(!callbackPluginId||!requestId)return Promise.resolve();',
    '  try{',
    '    var meta=findHttpMeta();',
    '    if(meta){return httpPostJson("127.0.0.1",meta.port,"/api/v1/plugins/"+callbackPluginId+"/invoke",{action:"storeAuthResult",payload:{requestId:requestId,ok:ok,message:msg}},meta.token).catch(function(){});}',
    '  }catch(_){}',
    '  return Promise.resolve();',
    '}',
    'postForm("openapi.baidu.com","/oauth/2.0/token",{grant_type:"authorization_code",code:code,client_id:appKey,client_secret:secretKey,redirect_uri:"oob"})',
    '.then(function(r){',
    ' if(!r.access_token){throw new Error(r.error_description||r.error||"no access_token");}',
    ' var data={access_token:r.access_token,refresh_token:r.refresh_token,expires_at:Date.now()+(r.expires_in||2592000)*1000,appKey:appKey,secretKey:secretKey};',
    ' fs.mkdirSync(path.dirname(tokenFile),{recursive:true});',
    ' fs.writeFileSync(tokenFile,JSON.stringify(data));',
    ' console.log("EXCHANGE_OK");',
    ' return callbackResult(true,"ok");',
    '})',
    '.catch(function(e){',
    ' console.error("EXCHANGE_FAIL:"+e.message);',
    ' try{fs.unlinkSync(tokenFile)}catch(_){}',
    ' callbackResult(false,e.message).finally(function(){setTimeout(function(){},1500)});',
    '});',
    '})();',
  ].join('');
}

/**
 * Build the Node script that reads tokens (refreshing if expired) and uploads
 * all .7z split volumes in localFolder to remotePath.
 */
function buildUploadScript(localFolder, remotePath, appKey, secretKey, tokenFile, callbackPluginId, requestId, fmbDataDir, bduss, concurrency) {
  var L = JSON.stringify(localFolder);
  var R = JSON.stringify(remotePath);
  var AK = JSON.stringify(appKey);
  var SK = JSON.stringify(secretKey);
  var F = JSON.stringify(tokenFile);
  var CID = JSON.stringify(callbackPluginId || '');
  var RID = JSON.stringify(requestId || '');
  var FDD = JSON.stringify(fmbDataDir || '');
  var BD = JSON.stringify(bduss || '');
  // Parallel part-upload workers; clamp to a sane range (default 4).
  var CONC = Math.max(1, Math.min(16, parseInt(concurrency, 10) || 4));
  return [
    '(function(){',
    'var fs=require("fs"),path=require("path"),https=require("https");',
    'var localFolder=' + L + ',remoteDir=' + R + ',appKey=' + AK + ',secretKey=' + SK + ',tokenFile=' + F + ',callbackPluginId=' + CID + ',requestId=' + RID + ',fmbDataDir=' + FDD + ',bduss=' + BD + ';',
    'var crypto=require("crypto");',
    'function postForm(host,path,form){',
    ' return new Promise(function(resolve,reject){',
    '  var body=Object.keys(form).map(function(k){return encodeURIComponent(k)+"="+encodeURIComponent(form[k])}).join("&");',
    '  var opt={hostname:host,path:path,method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded","Content-Length":Buffer.byteLength(body)}};',
    '  var req=https.request(opt,function(res){var d="";res.on("data",function(c){d+=c});res.on("end",function(){try{resolve(JSON.parse(d))}catch(e){reject(new Error("bad json: "+d))}})});',
    '  req.on("error",reject);req.write(body);req.end();',
    ' });',
    '}',
    'function getToken(){',
    ' return new Promise(function(resolve,reject){',
    '  if(bduss){resolve("BDUSS");return;}',
    '  var t={};',
    '  try{t=JSON.parse(fs.readFileSync(tokenFile,"utf8"))}catch(_){}',
    '  if(t.access_token && (!t.expires_at || t.expires_at > Date.now()+300000)){resolve(t.access_token);return;}',
    '  if(!t.refresh_token){reject(new Error("no refresh_token; please re-authorize"));return;}',
    '  postForm("openapi.baidu.com","/oauth/2.0/token",{grant_type:"refresh_token",refresh_token:t.refresh_token,client_id:appKey,client_secret:secretKey})',
    '  .then(function(r){',
    '   if(!r.access_token){throw new Error(r.error_description||r.error||"refresh failed");}',
    '   t.access_token=r.access_token;',
    '   if(r.refresh_token)t.refresh_token=r.refresh_token;',
    '   t.expires_at=Date.now()+(r.expires_in||2592000)*1000;',
    '   t.appKey=appKey;t.secretKey=secretKey;',
    '   fs.mkdirSync(path.dirname(tokenFile),{recursive:true});',
    '   fs.writeFileSync(tokenFile,JSON.stringify(t));',
    '   resolve(t.access_token);',
    '  }).catch(reject);',
    ' });',
    '}',
    'function encPath(p){return encodeURIComponent(p).replace(/%2F/gi,"/");}',
    'function md5FileSync(file){var h=crypto.createHash("md5");var buf=fs.readFileSync(file);h.update(buf);return h.digest("hex");}',
    'function md5FileChunks(file,chunkSize){',
    ' var stat=fs.statSync(file);var size=stat.size;',
    ' var md5s=[];var off=0;',
    ' var fd=fs.openSync(file,"r");',
    ' try{',
    '  while(off<size){var len=Math.min(chunkSize,size-off);var buf=Buffer.allocUnsafe(len);fs.readSync(fd,buf,0,len,off);var h=crypto.createHash("md5");h.update(buf);md5s.push(h.digest("hex"));off+=len;}',
    ' }finally{fs.closeSync(fd);}',
    ' return md5s;',
    '}',
    'function uploadFile(token,file){',
    ' return new Promise(function(resolve,reject){',
    '  if(bduss){reject(new Error("BDUSS upload not supported, please use OAuth API Key mode"));return;}',
    '  var fn=path.basename(file);',
    '  var rp=remoteDir.replace(/\\/+$/,"")+"/"+fn;',
    '  var stat=fs.statSync(file);var size=stat.size;',
    '  var CHUNK=4*1024*1024;',
    '  var blockList=md5FileChunks(file,CHUNK);',
    '  var blockListJson=JSON.stringify(blockList);',
    '  var prePath="/rest/2.0/xpan/file?method=precreate&access_token="+encodeURIComponent(token);',
    '  var preBody="path="+encPath(rp)+"&size="+size+"&isdir=0&autoinit=1&block_list="+encodeURIComponent(blockListJson);',
    '  var preOpt={hostname:"pan.baidu.com",path:prePath,method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded","Content-Length":Buffer.byteLength(preBody)}};',
    '  var preq=https.request(preOpt,function(pres){var pd="";pres.on("data",function(c){pd+=c});pres.on("end",function(){',
    '   if(pres.statusCode!==200){reject(new Error("precreate HTTP "+pres.statusCode+": "+pd));return;}',
    '   var pj;try{pj=JSON.parse(pd)}catch(e){reject(new Error("precreate bad json: "+pd));return;}',
    '   if(pj.error_code||pj.errno){reject(new Error("precreate err "+(pj.error_code||pj.errno)+": "+(pj.error_msg||pj.errmsg||pd)));return;}',
    '   var uploadid=pj.uploadid;if(!uploadid){reject(new Error("precreate: no uploadid in "+pd));return;}',
    '   var totalParts=blockList.length;var okParts=0;var nextSeq=0;var settled=false;',
    // Concurrent part uploads: a strictly-serial chain lets per-request
    // connect/response overhead eat most of the throughput. Worker count is
    // configurable via the uploader plugin's uploadConcurrency setting.
    '   var CONC=' + CONC + ';var MAXTRY=4;',
    '   function doCreate(){',
    '    var creBody="path="+encPath(rp)+"&size="+size+"&isdir=0&block_list="+encodeURIComponent(blockListJson)+"&uploadid="+encodeURIComponent(uploadid);',
    '    var crePath="/rest/2.0/xpan/file?method=create&access_token="+encodeURIComponent(token);',
    '    var creOpt={hostname:"pan.baidu.com",path:crePath,method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded","Content-Length":Buffer.byteLength(creBody)}};',
    '    var creq=https.request(creOpt,function(cres){var cd="";cres.on("data",function(c){cd+=c});cres.on("end",function(){',
    '     if(cres.statusCode!==200){reject(new Error("create HTTP "+cres.statusCode+": "+cd));return;}',
    '     var cj;try{cj=JSON.parse(cd)}catch(e){reject(new Error("create bad json: "+cd));return;}',
    '     if(cj.error_code||cj.errno){reject(new Error("create err "+(cj.error_code||cj.errno)+": "+(cj.error_msg||cj.errmsg||cd)));return;}',
    '     resolve(cd);',
    '    })});creq.on("error",reject);creq.write(creBody);creq.end();',
    '   }',
    // One part upload attempt. Transient failures (HTTP 5xx/403 -11015, network
    // resets, socket timeouts) retry up to MAXTRY times with linear backoff —
    // previously a single failed part killed the whole multi-GB file.
    '   function attempt(seq,tryNo){',
    '    if(settled)return;',
    '    var off=seq*CHUNK;var len=Math.min(CHUNK,size-off);',
    '    var boundary="----FMB"+Date.now()+"_"+seq+"_"+tryNo;',
    '    var header="--"+boundary+"\\r\\nContent-Disposition: form-data; name=\\"file\\"; filename=\\""+fn+"\\"\\r\\nContent-Type: application/octet-stream\\r\\n\\r\\n";',
    '    var footer="\\r\\n--"+boundary+"--\\r\\n";',
    '    var buf=Buffer.allocUnsafe(len);var fd=fs.openSync(file,"r");fs.readSync(fd,buf,0,len,off);fs.closeSync(fd);',
    '    var body=Buffer.concat([Buffer.from(header,"utf8"),buf,Buffer.from(footer,"utf8")]);',
    '    var sp="/rest/2.0/pcs/superfile2?method=upload&access_token="+encodeURIComponent(token)+"&type=tmpfile&path="+encPath(rp)+"&uploadid="+encodeURIComponent(uploadid)+"&partseq="+seq;',
    '    var sopt={hostname:"d.pcs.baidu.com",path:sp,method:"POST",headers:{"Content-Type":"multipart/form-data; boundary="+boundary,"Content-Length":body.length}};',
    '    function onFail(msg){',
    '     if(settled)return;',
    '     if(tryNo<MAXTRY){setTimeout(function(){attempt(seq,tryNo+1)},1000*tryNo);return;}',
    '     settled=true;reject(new Error("part "+seq+" failed after "+MAXTRY+" tries: "+msg));',
    '    }',
    '    var sreq=https.request(sopt,function(sres){var sd="";sres.on("data",function(c){sd+=c});sres.on("end",function(){',
    '     if(sres.statusCode!==200){onFail("HTTP "+sres.statusCode+": "+sd);return;}',
    '     var sj;try{sj=JSON.parse(sd)}catch(e){onFail("bad json: "+sd);return;}',
    '     if(sj.error_code||sj.errno){onFail("err "+(sj.error_code||sj.errno)+": "+(sj.error_msg||sj.errmsg||sd));return;}',
    '     okParts++;',
    // totalBytes/bytesDone let the uploader UI show a real percent + MB figure.
    '     callbackProgress("progress",{file:fn,part:seq,parts:totalParts,totalBytes:totalBytes,bytesDone:uploadedBytesBase+Math.min(okParts*CHUNK,size),filesDone:okCount+failCount,totalFiles:tasks.length});',
    '     pump();',
    '    })});',
    '    sreq.on("error",function(e){onFail("net: "+e.message)});',
    // A hung socket must not stall a worker forever: time out and retry.
    '    sreq.setTimeout(120000,function(){sreq.destroy(new Error("timeout 120s"))});',
    '    sreq.write(body);sreq.end();',
    '   }',
    // Worker pump: pull the next part index until exhausted; when the last
    // in-flight part lands, finalize with create.
    '   function pump(){',
    '    if(settled)return;',
    '    var seq=nextSeq++;',
    '    if(seq>=totalParts){if(okParts===totalParts){settled=true;doCreate();}return;}',
    '    attempt(seq,1);',
    '   }',
    '   var starters=Math.min(CONC,totalParts);for(var w=0;w<starters;w++){pump();}',
    '  })});preq.on("error",reject);preq.write(preBody);preq.end();',
    ' });',
    '}',
    'function httpPostJson(host,port,path,obj,token){',
    ' return new Promise(function(resolve,reject){',
    '  var body=JSON.stringify(obj);',
    '  var http=require("http");',
    '  var opt={hostname:host,port:port,path:path,method:"POST",headers:{"Content-Type":"application/json","Content-Length":Buffer.byteLength(body),"Authorization":"Bearer "+token}};',
    '  var req=http.request(opt,function(res){var d="";res.on("data",function(c){d+=c});res.on("end",function(){try{resolve(JSON.parse(d))}catch(e){resolve({status:res.statusCode,body:d})}})});',
    '  req.on("error",reject);req.write(body);req.end();',
    ' });',
    '}',
    'function findHttpMeta(){',
    '  if(process.env.FMB_HTTP_PORT && process.env.FMB_HTTP_TOKEN){return {port:parseInt(process.env.FMB_HTTP_PORT,10),token:process.env.FMB_HTTP_TOKEN};}',
    '  if(fmbDataDir){try{var m=path.join(fmbDataDir,"userData",".fmb-http.json");if(fs.existsSync(m)){return JSON.parse(fs.readFileSync(m,"utf8"))}}catch(_){}}',
    '  var cands=[path.join(process.env.LOCALAPPDATA||"","fairy-maid-brigade",".fmb-http.json"),path.join(process.env.APPDATA||"","fairy-maid-brigade",".fmb-http.json")];',
    '  for(var i=0;i<cands.length;i++){try{if(fs.existsSync(cands[i])){return JSON.parse(fs.readFileSync(cands[i],"utf8"))}}catch(_){}}',
    '  try{',
    '    var roots=[];',
    '    for(var dc=65;dc<=90;dc++){var dr=String.fromCharCode(dc)+":\\\\";try{if(fs.existsSync(dr))roots.push(dr)}catch(_){}}',
    '    for(var di=0;di<roots.length;di++){',
    '      var portable=path.join(roots[di],"fmb-data","userData",".fmb-http.json");',
    '      try{if(fs.existsSync(portable)){return JSON.parse(fs.readFileSync(portable,"utf8"))}}catch(_){}',
    '      var found=searchFile(roots[di],".fmb-http.json",5);',
    '      if(found)return JSON.parse(fs.readFileSync(found,"utf8"));',
    '    }',
    '  }catch(_){}',
    '  return null;',
    '}',
    'function searchFile(dir,name,depth){',
    '  if(depth<0)return null;',
    '  try{',
    '    var items=fs.readdirSync(dir,{withFileTypes:true});',
    '    for(var i=0;i<items.length;i++){',
    '      var it=items[i];',
    '      if(it.isFile()&&it.name===name)return path.join(dir,it.name);',
    '      if(it.isDirectory()){var sub=searchFile(path.join(dir,it.name),name,depth-1);if(sub)return sub;}',
    '    }',
    '  }catch(_){}',
    '  return null;',
    '}',
    'function callbackResult(ok,msg){',
    '  if(!callbackPluginId||!requestId)return;',
    '  try{',
    '    var meta=findHttpMeta();',
    '    if(meta){httpPostJson("127.0.0.1",meta.port,"/api/v1/plugins/"+callbackPluginId+"/invoke",{action:"storeUploadResult",payload:{requestId:requestId,ok:ok,message:msg,uploaded:okCount,failed:failCount,failures:failMsgs}},meta.token).catch(function(){});}',
    '  }catch(_){}',
    '}',
    'var progressCounter=0;',
    'function callbackProgress(phase,extra){',
    '  if(!callbackPluginId||!requestId)return;',
    '  try{',
    '    var meta=findHttpMeta();',
    '    if(meta){var p={requestId:requestId,phase:phase,counter:progressCounter++};if(extra){for(var k in extra)p[k]=extra[k]}httpPostJson("127.0.0.1",meta.port,"/api/v1/plugins/"+callbackPluginId+"/invoke",{action:"storeUploadResult",payload:p},meta.token).catch(function(){});}',
    '  }catch(_){}',
    '}',
    'var files;try{files=fs.readdirSync(localFolder).filter(function(f){return /\\.7z(\\.\\d+)?$/.test(f)})}catch(e){files=null;}',
    'var tasks=files?files.map(function(f){return path.join(localFolder,f)}):[];',
    'var resultFile=path.join(localFolder,"_upload_result.json");',
    'var okCount=0,failCount=0,failMsgs=[];var uploadedBytesBase=0;',
    'function writeResult(ok,msg){',
' try{fs.writeFileSync(resultFile,JSON.stringify({ok:ok,message:msg,uploaded:okCount,failed:failCount,failures:failMsgs}));}catch(_){}',
' callbackResult(ok,msg);',
' setTimeout(function(){},8000);',
'}',
    // Last-resort crash handlers: the script runs detached with stdio ignored,
    // so without these an unexpected crash would leave no result anywhere and
    // the client would hang until the stall detector fires.
    'process.on("uncaughtException",function(e){writeResult(false,"script crashed: "+e.message)});',
    'process.on("unhandledRejection",function(e){writeResult(false,"script rejection: "+String(e&&e.message||e))});',
    // Empty / missing folder must FAIL loudly — "0 uploaded, 0 failed" used to
    // pass as ok=true, which let the task chain mark itself COMPLETED without
    // uploading anything (fake success).
    'if(tasks.length===0){',
    ' var emptyMsg=files?("no .7z archive files found in "+localFolder):("local folder not readable: "+localFolder);',
    ' console.error("UPLOAD_FAIL:"+emptyMsg);',
    ' writeResult(false,emptyMsg);',
    '}else{',
    ' var totalBytes=0;tasks.forEach(function(t){try{totalBytes+=fs.statSync(t).size}catch(_){}});',
    ' callbackProgress("started",{totalBytes:totalBytes,totalFiles:tasks.length});',
    'getToken().then(function(token){',
    ' var i=0;',
    ' (function next(){',
    '  if(i>=tasks.length){',
    '   var msg=okCount+" uploaded, "+failCount+" failed";',
    '   console.log("UPLOAD_DONE:"+okCount+"/"+tasks.length);',
    '   writeResult(failCount===0,msg);return;',
    '  }',
    '  uploadFile(token,tasks[i]).then(function(){okCount++;try{uploadedBytesBase+=fs.statSync(tasks[i]).size}catch(_){}i++;next()}).catch(function(e){failCount++;failMsgs.push(path.basename(tasks[i])+": "+e.message);console.error("UPLOAD_FAIL:"+tasks[i]+":"+e.message);i++;next()});',
    ' })();',
    '}).catch(function(e){console.error("TOKEN_FAIL:"+e.message);writeResult(false,"token error: "+e.message)});',
    '}',
    '})();',
  ].join('');
}

/**
 * Build the Node script that lists directories at a given Baidu Netdisk path.
 * The script reads tokens (refreshing if needed), calls the Baidu PCS list API,
 * filters directories only, and POSTs the result back to the app plugin via the
 * FMB HTTP API (discovering port+token from .fmb-http.json).
 */
function buildListScript(dir, appKey, secretKey, tokenFile, callbackPluginId, requestId, fmbDataDir, bduss) {
  var D = JSON.stringify(dir);
  var AK = JSON.stringify(appKey);
  var SK = JSON.stringify(secretKey);
  var F = JSON.stringify(tokenFile);
  var CID = JSON.stringify(callbackPluginId);
  var RID = JSON.stringify(requestId);
  var FDD = JSON.stringify(fmbDataDir || '');
  var BD = JSON.stringify(bduss || '');
  return [
    '(function(){',
    'var fs=require("fs"),http=require("http"),https=require("https"),path=require("path"),os=require("os");',
    'var dir=' + D + ',appKey=' + AK + ',secretKey=' + SK + ',tokenFile=' + F + ',cbPlugin=' + CID + ',reqId=' + RID + ',fmbDataDir=' + FDD + ',bduss=' + BD + ';',
    'function postForm(host,path,form){',
    ' return new Promise(function(resolve,reject){',
    '  var body=Object.keys(form).map(function(k){return encodeURIComponent(k)+"="+encodeURIComponent(form[k])}).join("&");',
    '  var opt={hostname:host,path:path,method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded","Content-Length":Buffer.byteLength(body)}};',
    '  var req=https.request(opt,function(res){var d="";res.on("data",function(c){d+=c});res.on("end",function(){try{resolve(JSON.parse(d))}catch(e){reject(new Error("bad json: "+d))}})});',
    '  req.on("error",reject);req.write(body);req.end();',
    ' });',
    '}',
    'function httpGetJson(url,headers){',
    ' return new Promise(function(resolve,reject){',
    '  var u=new URL(url);var opt={hostname:u.hostname,path:u.pathname+u.search,method:"GET",headers:headers||{}};',
    '  https.get(opt,function(res){var d="";res.on("data",function(c){d+=c});res.on("end",function(){try{resolve(JSON.parse(d))}catch(e){reject(new Error("bad json: "+d))}})}).on("error",reject);',
    ' });',
    '}',
    'function httpPostJson(host,port,path,obj,token){',
    ' return new Promise(function(resolve,reject){',
    '  var body=JSON.stringify(obj);',
    '  var opt={hostname:host,port:port,path:path,method:"POST",headers:{"Content-Type":"application/json","Content-Length":Buffer.byteLength(body),"Authorization":"Bearer "+token}};',
    '  var req=http.request(opt,function(res){var d="";res.on("data",function(c){d+=c});res.on("end",function(){resolve({status:res.statusCode,body:d})})});',
    '  req.on("error",reject);req.write(body);req.end();',
    ' });',
    '}',
    'function getToken(){',
    ' return new Promise(function(resolve,reject){',
    '  if(bduss){resolve("BDUSS");return;}',
    '  var t={};',
    '  try{t=JSON.parse(fs.readFileSync(tokenFile,"utf8"))}catch(_){}',
    '  if(t.access_token && (!t.expires_at || t.expires_at > Date.now()+300000)){resolve(t.access_token);return;}',
    '  if(!t.refresh_token){reject(new Error("no refresh_token; please re-authorize"));return;}',
    '  postForm("openapi.baidu.com","/oauth/2.0/token",{grant_type:"refresh_token",refresh_token:t.refresh_token,client_id:appKey,client_secret:secretKey})',
    '  .then(function(r){',
    '   if(!r.access_token){throw new Error(r.error_description||r.error||"refresh failed");}',
    '   t.access_token=r.access_token;',
    '   if(r.refresh_token)t.refresh_token=r.refresh_token;',
    '   t.expires_at=Date.now()+(r.expires_in||2592000)*1000;',
    '   t.appKey=appKey;t.secretKey=secretKey;',
    '   fs.mkdirSync(path.dirname(tokenFile),{recursive:true});',
    '   fs.writeFileSync(tokenFile,JSON.stringify(t));',
    '   resolve(t.access_token);',
    '  }).catch(reject);',
    ' });',
    '}',
    'function findHttpMeta(){',
    '  if(process.env.FMB_HTTP_PORT && process.env.FMB_HTTP_TOKEN){return {port:parseInt(process.env.FMB_HTTP_PORT,10),token:process.env.FMB_HTTP_TOKEN};}',
    '  if(fmbDataDir){try{var m=path.join(fmbDataDir,"userData",".fmb-http.json");if(fs.existsSync(m)){return JSON.parse(fs.readFileSync(m,"utf8"))}}catch(_){}}',
    '  var cands=[path.join(process.env.LOCALAPPDATA||"","fairy-maid-brigade",".fmb-http.json"),path.join(process.env.APPDATA||"","fairy-maid-brigade",".fmb-http.json")];',
    '  for(var i=0;i<cands.length;i++){try{if(fs.existsSync(cands[i])){return JSON.parse(fs.readFileSync(cands[i],"utf8"))}}catch(_){}}',
    '  try{',
    '    var roots=[];',
    '    for(var dc=65;dc<=90;dc++){var dr=String.fromCharCode(dc)+":\\\\";try{if(fs.existsSync(dr))roots.push(dr)}catch(_){}}',
    '    for(var di=0;di<roots.length;di++){',
    '      var portable=path.join(roots[di],"fmb-data","userData",".fmb-http.json");',
    '      try{if(fs.existsSync(portable)){return JSON.parse(fs.readFileSync(portable,"utf8"))}}catch(_){}',
    '      var found=searchFile(roots[di],".fmb-http.json",5);',
    '      if(found)return JSON.parse(fs.readFileSync(found,"utf8"));',
    '    }',
    '  }catch(_){}',
    '  return null;',
    '}',
    'function searchFile(dir,name,depth){',
    '  if(depth<0)return null;',
    '  try{',
    '    var items=fs.readdirSync(dir,{withFileTypes:true});',
    '    for(var i=0;i<items.length;i++){',
    '      var it=items[i];',
    '      if(it.isFile()&&it.name===name)return path.join(dir,it.name);',
    '      if(it.isDirectory()){',
    '        var sub=searchFile(path.join(dir,it.name),name,depth-1);',
    '        if(sub)return sub;',
    '      }',
    '    }',
    '  }catch(_){}',
    '  return null;',
    '}',
    'getToken().then(function(token){',
    ' var url,headers;',
    ' if(bduss){',
    '  url="https://pan.baidu.com/rest/2.0/xpan/file?method=list&app_id=778750&dir="+encodeURIComponent(dir||"/");',
    '  headers={"Cookie":"BDUSS="+bduss,"User-Agent":"Mozilla/5.0"};',
    ' }else{',
    '  url="https://pan.baidu.com/rest/2.0/xpan/file?method=list&access_token="+encodeURIComponent(token)+"&dir="+encodeURIComponent(dir||"/");',
    '  headers={};',
    ' }',
    ' return httpGetJson(url,headers);',
    '}).then(function(r){',
    ' if(r.errno!==0){throw new Error((r.errmsg||"baidu api error")+" (errno "+r.errno+")");}',
    ' var list=(r.list||[]).filter(function(f){return f.isdir===1}).map(function(f){return f.path});',
    ' var meta=findHttpMeta();',
    ' if(!meta){throw new Error("无法定位 FMB HTTP 元数据");}',
    ' return httpPostJson("127.0.0.1",meta.port,"/api/v1/plugins/"+cbPlugin+"/invoke",{action:"storeDirList",payload:{requestId:reqId,list:list}},meta.token);',
    '}).then(function(res){',
    ' if(res && res.status===200){console.log("LIST_OK")}else{console.error("LIST_CALLBACK_FAIL:"+(res?res.status:"no response"))}',
    '}).catch(function(e){',
    ' console.error("LIST_FAIL:"+e.message);',
    ' var meta=findHttpMeta();',
    ' if(meta){httpPostJson("127.0.0.1",meta.port,"/api/v1/plugins/"+cbPlugin+"/invoke",{action:"storeDirList",payload:{requestId:reqId,list:[],error:e.message}},meta.token).catch(function(){})}',
    '});',
    '})();',
  ].join('');
}

/**
 * Poll until the named process is gone (or timeout). Returns true if gone.
 */
async function _waitForProcessExit(processName, maxWaitMs) {
  var start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    var q = await hostApi.processes.query({ processNames: [processName] });
    if (!q[processName]) return true;
    await new Promise(function (r) { setTimeout(r, 1000); });
  }
  return false;
}

/**
 * Check whether a file exists, using a uniquely-named probe process.
 *
 * The sandbox has no fs API, so the checker PowerShell (signal-on-EXISTS)
 * copies PING.EXE to `%TEMP%\<probe>.exe` under a per-check unique name and
 * starts it; we then poll processes.query for THAT name. Earlier versions
 * used a shared `ping` signal which cross-contaminated between consecutive
 * checks (a leftover ping from check A made check B report "missing" for an
 * existing file).
 */
async function _fileExists(filePath) {
  var probe = 'fmbp' + Math.random().toString(36).slice(2, 10);
  var probeExe = probe + '.exe';
  var checker =
    "if (Test-Path '" + filePath + "') { " +
    "Copy-Item \"$env:SystemRoot\\System32\\PING.EXE\" (Join-Path $env:TEMP '" + probeExe + "') -Force; " +
    "Start-Process (Join-Path $env:TEMP '" + probeExe + "') -ArgumentList '-n','6','127.0.0.1' -WindowStyle Hidden; " +
    "}";
  try {
    var enc = Buffer.from(checker, 'utf16le').toString('base64');
    await hostApi.processes.start({
      executablePath: _psPath(),
      args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc],
      detached: false, // PowerShell hangs under detached:true (no console)
      timeoutMs: 8000,
    });
  } catch (_) { /* checker spawn failed; treat as missing */ return false; }
  for (var i = 0; i < 16; i++) {
    await new Promise(function (r) { setTimeout(r, 500); });
    var q = await hostApi.processes.query({ processNames: [probeExe] });
    if (q[probeExe]) return true; // probe seen → file exists
  }
  return false; // no probe within 8s → file missing
}

/**
 * Launch a Node script directly via `node -e`. The script (~10KB) fits well
 * within the Windows 32767-char command-line limit. Using `detached: true`
 * lets the process run independently; results are communicated back via
 * HTTP callback → KV (not stdout).
 *
 * Previous approach used PowerShell to chunk-write a .b64 file then decode+run,
 * but processes.start returns immediately after spawn (before the process
 * finishes), so multiple chunk-write calls raced and the .b64 file was
 * corrupted. Direct `node -e` eliminates that race entirely.
 */
async function _launchScript(script, _scriptFile) {
  var nodePath = await _getNodePath();
  await hostApi.processes.start({
    executablePath: nodePath,
    args: ['-e', script],
    detached: true,
    timeoutMs: 10000,
  });
}

/**
 * Launch the list script. HTTP meta discovery is done inside the Node script
 * itself (findHttpMeta searches all drives). PowerShell just writes the file
 * and runs node — keeping the command line short and reliable.
 */
async function _launchListScript(script, scriptFile) {
  await _launchScript(script, scriptFile);
}

module.exports = {
  activate(ctx) {
    ctx.hostApi.logger.info('baidunetdisk activated', { pluginId: ctx.pluginId });
  },

  deactivate() {
    hostApi.logger.info('baidunetdisk deactivated', {});
  },

  /** Set the Node.js executable path. */
  async setNodePath(payload) {
    var p = payload && payload.path;
    if (p && p.trim()) {
      await hostApi.kv.set('config:nodePath', p.trim());
      return { ok: true, path: p.trim() };
    }
    return { ok: true, path: null };
  },

  /**
   * Exchange an OAuth authorization code for access_token + refresh_token.
   * Tokens are saved to tokenFile (JSON) for the upload step to read/refresh.
   * payload: { appKey, secretKey, code, tokenFile, callbackPluginId?, requestId? }
   * Returns { ok: true } on success, throws with the REAL Baidu error on failure
   * (relayed via the script's HTTP callback → global KV), falling back to the
   * token-file existence check when no callback ids are provided.
   */
  async exchangeCode(payload) {
    var appKey = payload && payload.appKey;
    var secretKey = payload && payload.secretKey;
    var code = payload && payload.code;
    var tokenFile = payload && payload.tokenFile;
    var callbackPluginId = payload && payload.callbackPluginId;
    var requestId = (payload && payload.requestId) || ('auth_' + Date.now() + '_' + Math.floor(Math.random() * 100000));
    if (!appKey) throw new Error('exchangeCode: appKey required');
    if (!secretKey) throw new Error('exchangeCode: secretKey required');
    if (!code) throw new Error('exchangeCode: code required');
    if (!tokenFile) throw new Error('exchangeCode: tokenFile required');

    // Remove any stale token file first via a PowerShell one-liner so we can
    // detect a fresh successful exchange by file existence.
    try {
      var rmCmd = "Remove-Item -Force -ErrorAction SilentlyContinue '" + tokenFile + "'";
      var rmEnc = Buffer.from(rmCmd, 'utf16le').toString('base64');
      await hostApi.processes.start({
        executablePath: _psPath(),
        args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', rmEnc],
        detached: false,
        timeoutMs: 5000,
      });
    } catch (_) {}

    var script = buildExchangeScript(appKey, secretKey, code, tokenFile, callbackPluginId, requestId, _fmbDataDir());
    var scriptFile = tokenFile.replace(/[^\\\/]+$/, '_exchange.js');

    hostApi.logger.info('baidunetdisk.exchangeCode: launching', { tokenFile: tokenFile, requestId: requestId });
    await _launchScript(script, scriptFile);

    if (callbackPluginId) {
      // Preferred path: the script POSTs the real outcome (with Baidu's error
      // message) to the app plugin, which stores it in the global KV. Poll it.
      var kvKey = 'authResult:' + requestId;
      var authResult = null;
      for (var i = 0; i < 24; i++) {
        await new Promise(function (r) { setTimeout(r, 500); });
        var v = await hostApi.kv.get(kvKey, true);
        if (v) {
          try { authResult = JSON.parse(v); } catch (_) {}
          break;
        }
      }
      if (authResult) await hostApi.kv.delete(kvKey, true);
      if (authResult) {
        if (authResult.ok) {
          hostApi.logger.info('baidunetdisk.exchangeCode: success', { tokenFile: tokenFile });
          return { ok: true };
        }
        hostApi.logger.warn('baidunetdisk.exchangeCode: failed', { message: authResult.message });
        throw new Error('授权失败: ' + (authResult.message || '未知错误'));
      }
      // Callback never arrived (e.g. HTTP server unreachable) — fall through
      // to the file-existence check below as a degraded path.
      hostApi.logger.warn('baidunetdisk.exchangeCode: auth callback timeout, falling back to file check', { requestId: requestId });
    }

    // Token exchange is a single HTTPS call; 8s is generous. We can't detect
    // the exact process exit (powershell/node names are shared), so we use a
    // fixed wait and then verify by checking if the token file was created.
    await new Promise(function (r) { setTimeout(r, 8000); });

    // The exchange script writes tokenFile only on success.
    var exists = await _fileExists(tokenFile);
    if (!exists) {
      hostApi.logger.warn('baidunetdisk.exchangeCode: failed — no token file', { tokenFile: tokenFile });
      throw new Error('授权码换取 token 失败，请检查 AppKey/SecretKey/授权码是否正确，或授权码是否已过期');
    }

    hostApi.logger.info('baidunetdisk.exchangeCode: success', { tokenFile: tokenFile });
    return { ok: true };
  },

  /**
   * Upload all .7z split volumes in localFolder to remotePath.
   * Reads tokens from tokenFile (refreshing access_token automatically).
   * payload: { localFolder, remotePath, appKey, secretKey, tokenFile, concurrency? }
   */
  async upload(payload) {
    var localFolder = payload && payload.localFolder;
    var remotePath = payload && payload.remotePath;
    var appKey = payload && payload.appKey;
    var secretKey = payload && payload.secretKey;
    var tokenFile = payload && payload.tokenFile;
    var bduss = payload && payload.bduss;
    var callbackPluginId = payload && payload.callbackPluginId;
    var requestId = (payload && payload.requestId) || ('up_' + Date.now() + '_' + Math.floor(Math.random() * 100000));
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(requestId)) throw new Error('upload: invalid requestId');

    if (!localFolder) throw new Error('upload: localFolder required');
    if (!remotePath) throw new Error('upload: remotePath required');
    if (!bduss && !appKey) throw new Error('upload: appKey required');
    if (!bduss && !secretKey) throw new Error('upload: secretKey required');
    if (!bduss && !tokenFile) throw new Error('upload: tokenFile required');

    var script = buildUploadScript(localFolder, remotePath, appKey, secretKey, tokenFile, callbackPluginId, requestId, _fmbDataDir(), bduss, payload && payload.concurrency);
    var scriptFile = localFolder + '\\_upload.js';

    hostApi.logger.info('baidunetdisk.upload: launching', {
      localFolder: localFolder,
      remotePath: remotePath,
      requestId: requestId,
    });
    await _launchScript(script, scriptFile);

    // Poll global KV for the final result, using progress callbacks as a
    // liveness signal. A fixed 180s cap used to kill large real uploads
    // (1.38GB needs minutes) while the detached script kept going — the task
    // was then falsely marked failed even though the upload later completed.
    //
    // Rules now:
    //   - no progress record at all within 60s → script never ran → fail fast
    //   - progress counter frozen for 10 min → genuinely stalled → fail
    //   - hard cap 12h as a last resort
    // NOTE: any progress record counts as liveness — do NOT gate on
    // phase==='started': later 'progress' writes OVERWRITE the same KV key,
    // so the 'started' phase is only visible for a brief window.
    var kvKey = 'uploadResult:' + requestId;
    var progKey = 'uploadProgress:' + requestId;
    var result = null;
    var lastCounter = -1;
    var lastChangeAt = Date.now();
    var sawAny = false;
    var waitStartedAt = Date.now();
    var HARD_CAP_MS = 12 * 60 * 60 * 1000;
    while (Date.now() - waitStartedAt < HARD_CAP_MS) {
      await new Promise(function (r) { setTimeout(r, 2000); });
      var v = await hostApi.kv.get(kvKey, true);
      if (v) {
        try { result = JSON.parse(v); } catch (_) {}
        break;
      }
      var pv = await hostApi.kv.get(progKey, true);
      if (pv) {
        try {
          var p = JSON.parse(pv);
          sawAny = true;
          if (typeof p.counter === 'number' && p.counter !== lastCounter) {
            lastCounter = p.counter;
            lastChangeAt = Date.now();
          }
        } catch (_) {}
      }
      if (!sawAny && Date.now() - waitStartedAt > 60000) {
        await hostApi.kv.delete(progKey, true);
        throw new Error('上传脚本未启动或无回调（请检查 FMB 的 HTTP 服务是否正常）');
      }
      if (sawAny && Date.now() - lastChangeAt > 600000) {
        await hostApi.kv.delete(progKey, true);
        throw new Error('上传停滞超过 10 分钟（网络中断或网盘无响应）。任务已标记为可恢复，可稍后自动/手动恢复续传');
      }
    }
    if (result) await hostApi.kv.delete(kvKey, true);
    await hostApi.kv.delete(progKey, true);

    if (!result) {
      hostApi.logger.warn('baidunetdisk.upload: hard cap reached', { localFolder: localFolder });
      throw new Error('上传超过 12 小时硬上限');
    }
    if (!result.ok) {
      hostApi.logger.error('baidunetdisk.upload: failed', { message: result.message, failures: result.failures });
      throw new Error(result.message || '上传失败');
    }
    hostApi.logger.info('baidunetdisk.upload: success', { uploaded: result.uploaded, localFolder: localFolder });
    return { ok: true, uploaded: result.uploaded, message: result.message };
  },

  /**
   * List subdirectories at a given Baidu Netdisk path.
   * The script calls the Baidu API and POSTs the result back to the app plugin
   * via the FMB HTTP API (callbackPluginId + requestId).
   * payload: { dir, appKey, secretKey, tokenFile, callbackPluginId, requestId }
   */
  async listDir(payload) {
    var dir = (payload && payload.dir) || '/';
    var appKey = payload && payload.appKey;
    var secretKey = payload && payload.secretKey;
    var tokenFile = payload && payload.tokenFile;
    var bduss = payload && payload.bduss;
    var callbackPluginId = payload && payload.callbackPluginId;
    var requestId = payload && payload.requestId;
    if (!bduss && !appKey) throw new Error('listDir: appKey required');
    if (!bduss && !secretKey) throw new Error('listDir: secretKey required');
    if (!bduss && !tokenFile) throw new Error('listDir: tokenFile required');
    if (!callbackPluginId) throw new Error('listDir: callbackPluginId required');
    if (!requestId) throw new Error('listDir: requestId required');

    var script = buildListScript(dir, appKey, secretKey, tokenFile, callbackPluginId, requestId, _fmbDataDir(), bduss);
    // Write the script to the system temp dir — the work dir root has shown
    // sporadic write-access issues under certain FMB runtimes, while %TEMP%
    // is always writable by the launched external process.
    var env = (typeof __hostEnv === 'object' && __hostEnv) ? __hostEnv : {};
    var tmpDir = (env.LOCALAPPDATA || 'C:\\Users\\Public\\AppData\\Local') + '\\Temp';
    var scriptFile = tmpDir + '\\_fmb_listdir_' + requestId + '.js';

    hostApi.logger.info('baidunetdisk.listDir: launching', { dir: dir, scriptFile: scriptFile });
    await _launchListScript(script, scriptFile);
    return { ok: true };
  },

  /** Helper: return the generated upload script (for debugging). */
  getUploadScript(payload) {
    return {
      script: buildUploadScript(
        payload.localFolder || '',
        payload.remotePath || '',
        payload.appKey || '',
        payload.secretKey || '',
        payload.tokenFile || '',
        undefined, undefined, undefined, undefined,
        payload.concurrency
      ),
    };
  },
};
