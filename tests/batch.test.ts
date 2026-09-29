import assert from "node:assert/strict";
import {test} from "node:test";
import {spawn, execFileSync} from "node:child_process";
import {createInterface} from "node:readline";
import {mkdtempSync, mkdirSync, realpathSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import type {Book, HostAPI, Series, Task} from "../sdk/types.ts";
import {documentRef} from "../sdk/types.ts";
import {createPreset, splitPages} from "../plugins/editor/src/pages.ts";
import {runBatch, type BatchRow} from "../plugins/editor/src/batch.ts";

// Exercise the actual editor preset and batch coordinator against the Python RPC engine.
test("batch edits different books, preserves active edits, handles collisions, failures and cancellation", async () => {
  const root = mkdtempSync(join(tmpdir(),"foluma-batch-")), python = join(process.cwd(),".venv/bin/python");
  execFileSync(python,["-c",`
import io,sys
from pathlib import Path
import pymupdf as fitz
from PIL import Image
root=Path(sys.argv[1]); image=io.BytesIO(); Image.new('RGB',(120,160),'navy').save(image,'JPEG')
for name,count in [('a',4),('b',6),('short',1)]:
 directory=root/name; directory.mkdir()
 with fitz.open() as doc:
  for _ in range(count):
   page=doc.new_page(width=120,height=160); xref=page.insert_image(page.rect,stream=image.getvalue()); doc.xref_set_key(xref,'ColorSpace','/DeviceRGB')
  doc.save(directory/'volume.pdf')
Image.new('RGB',(120,160),'red').save(root/'insert.png')
`,root]);
  const engine = spawn(python,["-m","foluma","--serve"],{env: {...process.env,FOLUMA_DATA: join(root,"data")}});
  const pending = new Map<number,{resolve: (value: any) => void; reject: (reason: any) => void}>();
  let nextId=0, active: Book|null=null;
  const output = createInterface({input: engine.stdout});
  output.on("line",line => {
    const message=JSON.parse(line);
    if(message.method==="document.changed")active=message.params;
    const waiter=pending.get(message.id);
    if(waiter){pending.delete(message.id); if(message.error)waiter.reject(Object.assign(new Error(message.error.message),{data:message.error.data}));else waiter.resolve(message.result);}
  });
  const rpc = <T=unknown>(method: string, params: Record<string,unknown> = {}): Promise<T> => new Promise((resolve,reject) => {
    const id=++nextId; pending.set(id,{resolve,reject}); engine.stdin.write(JSON.stringify({jsonrpc:"2.0",id,method,params})+"\n");
  });
  const host = {
    rpc, report: (error: unknown) => {throw error;},
    apply: (book: Book,changes: unknown) => rpc<Book>("document.apply",{...documentRef(book),changes}),
    task: async <T>(params: Record<string,unknown>): Promise<T> => {
      let job = await rpc<Task>("task.start",params);
      while(job.state==="running"){await new Promise(resolve=>setTimeout(resolve,10));job=await rpc<Task>("task.get",{id:job.id});}
      if(job.state!=="completed")throw Object.assign(new Error(job.error?.message),{data:job.error?.data,cancelled:job.state==="cancelled"});
      return job.result as T;
    },
  } as unknown as HostAPI;
  try {
    let book = await host.task<Book>({operation:"import",path:join(root,"a/volume.pdf")});
    book = await host.task<Book>({operation:"images.import",...documentRef(book),paths:[join(root,"insert.png")],position:1});
    const split=splitPages(book,new Set([book.pages[2].id]),.4);
    book=await host.apply(book,{pages:[...split.pages!,{id:crypto.randomUUID(),kind:"blank",width:120,height:160}],metadata:{...split.metadata,title:"Working copy",cover_only:true}});
    const before=structuredClone(book), preset=join(root,"layout.mtepreset");
    await rpc("bundle.write",{...documentRef(book),path:preset,plugin:"org.foluma.editor",...createPreset(book)});
    const directory=join(root,"out");mkdirSync(directory);writeFileSync(join(directory,"volume.epub"),"keep me");
    const paths=[join(root,"a/volume.pdf"),join(root,"short/volume.pdf"),join(root,"b/volume.pdf")], rows: BatchRow[]=[];
    await runBatch(host,{paths,preset,directory,render:false,dpi:300},new AbortController().signal,(index,row)=>rows[index]=row);
    assert.deepEqual(rows.map(row=>row.state),["completed","failed","completed"],JSON.stringify(rows));
    assert.match(rows[1].error!,/Missing preset asset or PDF page/);
    assert.equal(readFileSync(join(directory,"volume.epub"),"utf8"),"keep me");
    assert.equal(rows[0].output,realpathSync(join(directory,"volume (2).epub")));assert.equal(rows[2].output,realpathSync(join(directory,"volume (3).epub")));
    const spineCounts=JSON.parse(execFileSync(python,["-c",`
import json,sys,zipfile,xml.etree.ElementTree as ET
counts=[]
for path in sys.argv[1:]:
 with zipfile.ZipFile(path) as z:
  assert z.testzip() is None
  opf=ET.fromstring(z.read('EPUB/content.opf'))
  counts.append(len(opf.findall('{http://www.idpf.org/2007/opf}spine/{http://www.idpf.org/2007/opf}itemref')))
print(json.dumps(counts))
`,rows[0].output!,rows[2].output!],{encoding:"utf8"}));
    assert.deepEqual(spineCounts,[6,8]);
    assert.deepEqual(await rpc("document.get"),before);assert.deepEqual(active,before);
    const abort=new AbortController(), cancelledRows: BatchRow[]=[];
    await runBatch(host,{paths,preset,directory,render:false,dpi:300},abort.signal,(index,row)=>{cancelledRows[index]=row;if(row.state==="completed")abort.abort();});
    assert.deepEqual(cancelledRows.map(row=>row.state),["completed","skipped","skipped"]);
    assert.deepEqual(await rpc("document.get"),before);

    const broken=join(root,"broken.pdf"); writeFileSync(broken,"invalid PDF");
    const series=await rpc<Series>("series.scan",{paths:[...paths,broken]});
    const first=series.items.find(item=>item.path===realpathSync(paths[0]))!;
    let current=await host.task<Book>({operation:"series.open",entry_id:first.id});
    current=await host.apply(current,{pages:[...current.pages,{id:crypto.randomUUID(),kind:"blank",width:120,height:160}]});
    await rpc("series.review",{id:first.id,reviewed:true});
    const preserved=structuredClone(current), seriesRows: BatchRow[]=[];
    await runBatch(host,{paths:[first.path,realpathSync(broken),realpathSync(paths[2]),realpathSync(paths[1])],entries:series.items,directory,render:false,dpi:300},new AbortController().signal,(index,row)=>seriesRows[index]=row);
    assert.deepEqual(seriesRows.map(row=>row.state),["completed","failed","completed","completed"]);
    assert.deepEqual(await rpc("document.get"),preserved,"exporting the current series volume must preserve its edits and undo state");
    const finalSeries=await rpc<Series>("series.get");
    assert.equal(finalSeries.items.filter(item=>item.exported).length,3);
    assert.equal(finalSeries.items.filter(item=>item.reviewed).length,1,"exporting must not mark books reviewed");
    assert.equal(finalSeries.items.find(item=>item.id===first.id)!.page_count,5);
  } finally {
    engine.stdin.end(); await new Promise<void>(resolve=>engine.once("exit",()=>resolve()));output.close();rmSync(root,{recursive:true,force:true});
  }
});
