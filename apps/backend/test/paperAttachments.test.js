import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import http from 'node:http';
import test from 'node:test';
import { PDFDocument } from 'pdf-lib';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { createPdfDownloader, isPublicAddress, parseDownloadUrl, parseDownloadProxy } from '../src/services/paperAttachments/download.js';
import { createAttachmentRepository } from '../src/services/paperAttachments/repository.js';
import { createPaperAttachmentService } from '../src/services/paperAttachments/index.js';
import { registerPaperAttachmentRoutes } from '../src/routes/paperAttachments.js';

const cacheRoot = path.resolve('.cache/research-workbench-v2/reader');
await fs.mkdir(cacheRoot, { recursive: true });
const pdfDoc = await PDFDocument.create();
pdfDoc.addPage([100,100]);
const pdfBytes = Buffer.from(await pdfDoc.save());
const publicDns = async () => [{ address: '93.184.215.14', family: 4 }];
function response(bytes, statusCode = 200, headers = {}) {
  return Object.assign(Readable.from([bytes]), { statusCode, headers });
}
async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(cacheRoot, 'attachments-test-'));
  for (const id of ['a','b']) await fs.mkdir(path.join(directory,id));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const repository = createAttachmentRepository({ resolveProject: async id => {
    if (!['a','b'].includes(id)) throw Object.assign(new Error('private path'), { code: 'ENOENT' });
    return path.join(directory,id);
  } });
  const lookupPaper = async (projectId,paperId) => {
    if (!['a','b'].includes(projectId) || !['paper-1','paper-2'].includes(paperId)) throw new Error('not found');
    return { id: paperId, arxivId: '1706.03762', url: 'https://arxiv.org/abs/1706.03762v1' };
  };
  return { directory, repository, service: createPaperAttachmentService({ repository, lookupPaper, ...options }) };
}
async function finish(service, job) {
  for (let n=0;n<100;n++) {
    const current=await service.getJob('a','paper-1',job.id);
    if (['completed','failed','cancelled'].includes(current.status)) return current;
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  throw new Error('Download did not finish');
}

test('download accepts supported HTTPS sources, validates all DNS answers and pins the selected address', async () => {
  assert.equal(parseDownloadUrl('https://arxiv.org/pdf/1706.03762').hostname, 'arxiv.org');
  for (const url of ['http://arxiv.org/pdf/a','https://arxiv.org:444/pdf/a','https://a:b@arxiv.org/pdf/a','https://127.0.0.1/x','https://arxiv.org.evil.test/x','https://files.zenodo.org/x','file:///x']) {
    assert.throws(()=>parseDownloadUrl(url));
  }
  for (const address of ['127.0.0.1','10.2.3.4','100.64.0.1','169.254.169.254','172.16.0.1','192.168.1.1','0.0.0.0','198.18.0.1','224.0.0.1','::1','::ffff:127.0.0.1','fd00::1','fe80::1','2001:db8::1','2001::1','2001:2::1','2002:7f00:1::','3fff::1']) assert.equal(isPublicAddress(address),false,address);
  assert.equal(isPublicAddress('2606:4700:4700::1111'),true);
  let calls=0;
  const downloader=createPdfDownloader({ lookupImpl:publicDns, requestImpl:async (url,address) => {
    calls++;
    assert.equal(url.hostname,'arxiv.org');assert.deepEqual(address,{address:'93.184.215.14',family:4});
    return response(pdfBytes,200,{'content-length':String(pdfBytes.length)});
  } });
  const progress=[];
  const result=await downloader('https://arxiv.org/pdf/1706.03762',{onProgress:value=>progress.push(value)});
  assert.deepEqual(result.bytes,pdfBytes);assert.equal(calls,1);assert.equal(progress.at(-1).received,pdfBytes.length);
  const unsafe=createPdfDownloader({ lookupImpl:async()=>[{address:'93.184.215.14',family:4},{address:'127.0.0.1',family:4}], requestImpl:async()=>{throw new Error('must not connect');} });
  await assert.rejects(unsafe('https://arxiv.org/pdf/x'),{code:'ATTACHMENT_PRIVATE_ADDRESS'});
});

test('download checks each redirect and enforces declared and streamed size limits', async () => {
  let calls=0,lookups=0;
  const downloader=createPdfDownloader({ lookupImpl:async()=>{lookups++;return publicDns();}, requestImpl:async()=>{
    calls++;return calls===1?response('',302,{location:'https://export.arxiv.org/pdf/1706.03762'}):response(pdfBytes);
  } });
  assert.equal((await downloader('https://arxiv.org/pdf/1706.03762')).redirects.length,1);
  assert.equal(lookups,2);
  const unsafe=createPdfDownloader({lookupImpl:publicDns,requestImpl:async()=>response('',302,{location:'https://127.0.0.1/secret'})});
  await assert.rejects(unsafe('https://arxiv.org/pdf/x'),{code:'ATTACHMENT_SOURCE_UNSUPPORTED'});
  for (const headers of [{'content-length':'100'},{}]) {
    const tooLarge=createPdfDownloader({maxBytes:10,lookupImpl:publicDns,requestImpl:async()=>response(Buffer.alloc(11),200,headers)});
    await assert.rejects(tooLarge('https://arxiv.org/pdf/x'),{code:'ATTACHMENT_TOO_LARGE'});
  }
});

test('DNS lookup timeout and cancellation never start the downstream connection', async () => {
  let connections=0;
  const keepAlive=setTimeout(()=>{},1000);
  try {
    const downloader=createPdfDownloader({ timeoutMs:15, lookupImpl:()=>new Promise(()=>{}), requestImpl:()=>{connections++;} });
    await assert.rejects(downloader('https://arxiv.org/pdf/x'),{code:'ATTACHMENT_TIMEOUT'});
    const controller=new AbortController();
    let resolveDns;
    const cancelled=createPdfDownloader({ lookupImpl:()=>new Promise(resolve=>{resolveDns=resolve;}), requestImpl:()=>{connections++;} });
    const pending=cancelled('https://arxiv.org/pdf/x',{signal:controller.signal});
    controller.abort();
    await assert.rejects(pending,{code:'ATTACHMENT_CANCELLED'});
    resolveDns(await publicDns());
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(connections,0);
  } finally { clearTimeout(keepAlive); }
});

test('explicit trusted proxy skips local fake DNS but keeps every redirect on exact supported HTTPS hosts', async () => {
  let calls=0;
  const options={proxyUrl:'http://127.0.0.1:7892',lookupImpl:()=>{throw new Error('proxy resolves target');},requestImpl:async(url,address,{proxyUrl})=>{
    assert.equal(address,null);assert.equal(proxyUrl.hostname,'127.0.0.1');calls++;
    return calls===1?response('',302,{location:'https://export.arxiv.org/pdf/x'}):response(pdfBytes);
  }};
  const result=await createPdfDownloader(options)('https://arxiv.org/pdf/x');
  assert.equal(result.transport,'trusted-proxy');assert.equal(calls,2);
  for(const target of ['https://127.0.0.1/x','https://files.zenodo.org/x','http://arxiv.org/x','https://arxiv.org:444/x','https://u:p@arxiv.org/x']) {
    let connections=0;
    const download=createPdfDownloader({...options,requestImpl:async()=>{connections++;return response('',302,{location:target});}});
    await assert.rejects(download('https://arxiv.org/pdf/x'));
    assert.equal(connections,1,'reject destination before a second proxy connection');
  }
  assert.equal(parseDownloadProxy(undefined),null);assert.equal(parseDownloadProxy(''),null);
  for(const proxy of ['socks5://127.0.0.1:1080','http://127.0.0.1/path','http://user:secret@127.0.0.1/?secret','http://%zz:secret@localhost']) {
    assert.throws(()=>parseDownloadProxy(proxy),error=>error.code==='ATTACHMENT_PROXY_CONFIGURATION'&&!error.message.includes('secret'));
  }
});

async function proxyFixture(t, handler) {
  const sockets=new Set();
  const server=http.createServer();
  server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
  server.on('connect',handler);
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  t.after(async()=>{for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));});
  return `http://127.0.0.1:${server.address().port}`;
}

test('CONNECT uses target hostname, contains proxy authentication, and reports sanitized failures',async t=>{
  let called=0;
  const proxy=await proxyFixture(t,(request,socket)=>{
    called++;
    assert.equal(request.url,'arxiv.org:443');
    assert.equal(request.headers['proxy-authorization'],`Basic ${Buffer.from('user:password').toString('base64')}`);
    socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n');
  });
  const download=createPdfDownloader({proxyUrl:proxy.replace('http://','http://user:password@'),timeoutMs:1000});
  await assert.rejects(download('https://arxiv.org/pdf/x'),error=>error.code==='ATTACHMENT_DOWNLOAD_HTTP_ERROR'&&error.message.includes('407')&&!error.message.includes('password'));
  assert.equal(called,1);
});

test('cancelling a pending CONNECT destroys the actual proxy socket',async t=>{
  let connected,closed;
  const entered=new Promise(resolve=>{connected=resolve;});
  const disconnected=new Promise(resolve=>{closed=resolve;});
  const proxy=await proxyFixture(t,(_,socket)=>{socket.once('end',closed);socket.resume();connected();});
  const controller=new AbortController();
  const pending=createPdfDownloader({proxyUrl:proxy,timeoutMs:1000})('https://arxiv.org/pdf/x',{signal:controller.signal});
  await entered;controller.abort();
  await assert.rejects(pending,{code:'ATTACHMENT_CANCELLED'});
  let timer;
  try { await Promise.race([disconnected,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('CONNECT socket remained open')),500);})]); }
  finally { clearTimeout(timer); }
});

test('repository imports real PDFs, keeps versions and deduplicates by hash without crossing papers',async t=>{
  const {service,directory}=await fixture(t);
  const imported=await service.importPdf('a','paper-1',{filename:'paper.pdf',bytes:pdfBytes});
  assert.equal(imported.attachment.pageCount,1);assert.equal(imported.attachment.source,'upload');assert.equal(imported.attachment.sourceUrl,null);
  const duplicate=await service.importPdf('a','paper-1',{filename:'different.pdf',bytes:pdfBytes});
  assert.equal(duplicate.duplicate,true);assert.equal(duplicate.attachment.filename,'paper.pdf');
  assert.equal((await service.list('a','paper-1')).attachments.length,1);
  await service.importPdf('a','paper-2',{filename:'paper.pdf',bytes:pdfBytes});
  assert.equal((await fs.readdir(path.join(directory,'a','.scienceprism/paper-attachments'))).length,1,'physical bytes are reused');
  await assert.rejects(service.content('b','paper-1',imported.attachment.id),{code:'ATTACHMENT_NOT_FOUND'});
  await assert.rejects(service.importPdf('a','missing',{filename:'paper.pdf',bytes:pdfBytes}),{code:'ATTACHMENT_PAPER_NOT_FOUND'});
  assert.deepEqual((await service.content('a','paper-1',imported.attachment.id)).bytes,pdfBytes);
  const next=await PDFDocument.create();next.addPage([120,100]);
  const changed=await service.importPdf('a','paper-1',{filename:'new.pdf',bytes:Buffer.from(await next.save())});
  assert.notEqual(changed.attachment.sha256,imported.attachment.sha256);
  assert.equal((await service.list('a','paper-1')).attachments.length,2);
});

test('imports reject fake, damaged, oversized and unsafe files without adding records',async t=>{
  const {service}=await fixture(t);
  for (const bytes of [Buffer.from('<html>not pdf</html>'),Buffer.from('%PDF-1.7\ninvalid'),Buffer.alloc(0),Buffer.alloc(32*1024*1024+1)]) {
    await assert.rejects(service.importPdf('a','paper-1',{filename:'paper.pdf',bytes}));
  }
  for(const filename of ['../a.pdf','x\\a.pdf','test.txt','a\n.pdf','\ud800.pdf']) await assert.rejects(service.importPdf('a','paper-1',{filename,bytes:pdfBytes}),{code:'ATTACHMENT_INVALID_FILENAME'});
  assert.equal((await service.list('a','paper-1')).attachments.length,0);
});

test('storage rejects symlinks and altered hash content, preserving outside files',async t=>{
  const {service,directory}=await fixture(t);
  const outside=path.join(directory,'outside');await fs.mkdir(outside);
  await fs.symlink(outside,path.join(directory,'a','.scienceprism'),'dir');
  await assert.rejects(service.importPdf('a','paper-1',{filename:'paper.pdf',bytes:pdfBytes}),{code:'ATTACHMENT_UNSAFE_PATH'});
  assert.deepEqual(await fs.readdir(outside),[]);
  await fs.unlink(path.join(directory,'a','.scienceprism'));
  const {attachment}=await service.importPdf('a','paper-1',{filename:'paper.pdf',bytes:pdfBytes});
  const target=path.join(directory,'a','.scienceprism/paper-attachments',attachment.sha256+'.pdf');
  const altered=Buffer.from(pdfBytes);altered[0]^=1;
  await fs.writeFile(target,altered);
  await assert.rejects(service.content('a','paper-1',attachment.id),{code:'ATTACHMENT_HASH_MISMATCH'});
  await assert.rejects(service.importPdf('a','paper-1',{filename:'paper.pdf',bytes:pdfBytes}),{code:'ATTACHMENT_HASH_MISMATCH'});
});

test('download jobs publish actual PDFs, preserve failed attempts and support retry/cache/refresh',async t=>{
  let calls=0;
  const {service}=await fixture(t,{download:async(url,{onProgress})=>{
    calls++;assert.equal(url,'https://arxiv.org/pdf/1706.03762v1');
    await onProgress({received:pdfBytes.length,total:pdfBytes.length});
    return {bytes:calls===1?Buffer.from('not pdf'):pdfBytes,resolvedUrl:url};
  }});
  const first=await service.startDownload('a','paper-1',{});
  assert.equal((await finish(service,first.job)).status,'failed');
  assert.equal((await service.list('a','paper-1')).attachments.length,0);
  const retry=await service.startDownload('a','paper-1',{});
  assert.equal(retry.job.retryOf,first.job.id);
  const done=await finish(service,retry.job);
  assert.equal(done.status,'completed');assert.equal(done.receivedBytes,pdfBytes.length);
  assert.equal((await service.getJob('a','paper-1',first.job.id)).status,'failed');
  const cached=await service.startDownload('a','paper-1',{});assert.equal(cached.cached,true);assert.equal(calls,2);
  const refreshed=await service.startDownload('a','paper-1',{refresh:true});
  assert.equal((await finish(service,refreshed.job)).status,'completed');assert.equal(calls,3);
  assert.equal((await service.list('a','paper-1')).attachments.length,1);
});

test('downloads prefer supported oaPdfUrl, fall back to arXiv, and reject unsupported URLs',async t=>{
  let downloaded;
  const current={id:'paper-1',oaPdfUrl:'https://zenodo.org/records/123/files/paper.pdf',arxivId:'1706.03762'};
  const {service}=await fixture(t,{lookupPaper:async()=>current,download:async url=>{downloaded=url;return {bytes:pdfBytes,resolvedUrl:url};}});
  let result=await service.startDownload('a','paper-1',{});await finish(service,result.job);
  assert.equal(downloaded,current.oaPdfUrl);
  current.oaPdfUrl='https://unsupported.invalid/file.pdf';
  result=await service.startDownload('a','paper-1',{});await finish(service,result.job);
  assert.equal(downloaded,'https://arxiv.org/pdf/1706.03762');
  delete current.arxivId;
  await assert.rejects(service.startDownload('a','paper-1',{}),{code:'ATTACHMENT_SOURCE_UNSUPPORTED'});
  await assert.rejects(service.startDownload('a','paper-1',{url:'https://127.0.0.1/file.pdf'}),{code:'ATTACHMENT_SOURCE_UNSUPPORTED'});
});

test('cancellation reaches the real worker and does not publish a file; duplicate active downloads reuse a job',async t=>{
  let started,observedSignal;
  const entered=new Promise(resolve=>{started=resolve;});
  const {service}=await fixture(t,{download:async(_,{signal})=>{
    observedSignal=signal;started();
    return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  }});
  const {job}=await service.startDownload('a','paper-1',{});await entered;
  const duplicate=await service.startDownload('a','paper-1',{});assert.equal(duplicate.job.id,job.id);assert.equal(duplicate.existing,true);
  const cancelled=await service.cancelDownload('a','paper-1',job.id);assert.equal(cancelled.status,'cancelled');assert.equal(observedSignal.aborted,true);
  assert.equal((await service.list('a','paper-1')).attachments.length,0);
  assert.equal((await service.cancelDownload('a','paper-1',job.id)).status,'cancelled');
  await assert.rejects(service.getJob('b','paper-1',job.id),{code:'ATTACHMENT_JOB_NOT_FOUND'});
});

test('restart projects unfinished jobs as interrupted without writing on read',async t=>{
  const {service,repository,directory}=await fixture(t);
  await repository.update('a',index=>index.jobs.push({id:'pdf-download-old',paperId:'paper-1',status:'running',sourceUrl:'https://arxiv.org/pdf/x'}));
  const index=path.join(directory,'a','.scienceprism/paper-attachments.json');
  const before=await fs.readFile(index,'utf8');
  const job=await service.getJob('a','paper-1','pdf-download-old');assert.equal(job.status,'failed');assert.equal(job.interrupted,true);
  assert.equal(await fs.readFile(index,'utf8'),before);
});

test('multipart import and Range content work through the real attachment routes',async t=>{
  const {service}=await fixture(t);
  const app=Fastify();await app.register(multipart);registerPaperAttachmentRoutes(app,{service});t.after(()=>app.close());
  const base='/api/projects/a/papers/paper-1/attachments';
  const boundary='attachment-test-boundary';
  const form=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="sample.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),pdfBytes,Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const imported=await app.inject({method:'POST',url:base,headers:{'content-type':`multipart/form-data; boundary=${boundary}`},payload:form});
  assert.equal(imported.statusCode,200,imported.body);
  const url=base+'/'+imported.json().attachment.id+'/content';
  const full=await app.inject(url);assert.equal(full.statusCode,200);assert.deepEqual(full.rawPayload,pdfBytes);
  const partial=await app.inject({url,headers:{range:'bytes=0-9'}});assert.equal(partial.statusCode,206);assert.deepEqual(partial.rawPayload,pdfBytes.subarray(0,10));
  assert.equal(partial.headers['content-range'],`bytes 0-9/${pdfBytes.length}`);
  const suffix=await app.inject({url,headers:{range:'bytes=-10'}});assert.equal(suffix.statusCode,206);assert.deepEqual(suffix.rawPayload,pdfBytes.subarray(-10));
  const invalid=await app.inject({url,headers:{range:'bytes=99999999-'}});assert.equal(invalid.statusCode,416);
  const crossProject=await app.inject(url.replace('/projects/a/','/projects/b/'));assert.equal(crossProject.statusCode,404);
  const listing=await app.inject(base);assert.equal(listing.json().attachments.length,1);
});
