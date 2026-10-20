// Research microbenchmark: prebuilt cell span pack/unpack; NOT Rust, VT, GPU or socket performance.
import { performance } from 'node:perf_hooks';
import os from 'node:os';
const panes=16, cols=120, rows=40, cellBytes=16;
const grids=Array.from({length:panes},(_,p)=>{const a=new Uint8Array(cols*rows*cellBytes);for(let i=0;i<a.length;i++)a[i]=(i+p)%251;return a;});
const restored=grids.map(g=>new Uint8Array(g.length));
let checksum=0;
function bench(dirtyRows){
 const bytes=32+panes*dirtyRows*(16+cols*cellBytes), out=new Uint8Array(bytes), view=new DataView(out.buffer);
 function roundtrip(seq){
  view.setUint32(0,0x524f4f4d,true);view.setUint16(4,2,true);view.setUint16(6,1,true);view.setUint32(8,1,true);view.setBigUint64(12,BigInt(seq),true);view.setBigUint64(20,BigInt(seq-1),true);view.setUint32(28,bytes-32,true);
  let offset=32;
  for(let p=0;p<panes;p++)for(let r=0;r<dirtyRows;r++){
   const row=(r+seq)%rows;
   view.setUint32(offset,p,true);view.setUint16(offset+4,row,true);view.setUint16(offset+6,0,true);view.setUint16(offset+8,cols,true);view.setUint16(offset+10,0,true);view.setUint32(offset+12,0,true);
   offset+=16;out.set(grids[p].subarray(row*cols*cellBytes,(row+1)*cols*cellBytes),offset);offset+=cols*cellBytes;
  }
  for(let o=32;o<bytes;){const p=view.getUint32(o,true),r=view.getUint16(o+4,true),count=view.getUint16(o+8,true);o+=16;restored[p].set(out.subarray(o,o+count*cellBytes),r*cols*cellBytes);o+=count*cellBytes;}
  checksum^=restored[seq%panes][seq%restored[0].length];
 }
 for(let i=1;i<=2000;i++)roundtrip(i);
 const samples=[], cpuStart=process.cpuUsage(), start=performance.now();
 for(let i=1;i<=10000;i++){const t=performance.now();roundtrip(i);samples.push((performance.now()-t)*1000);}
 const elapsedMs=performance.now()-start,cpu=process.cpuUsage(cpuStart);samples.sort((a,b)=>a-b);
 return {dirtyRows,bytes,iterations:10000,roundtripMedianUs:samples[5000],roundtripP99Us:samples[9900],elapsedMs,cpuMs:(cpu.user+cpu.system)/1000,payloadMBps60:bytes*60/1e6};
}
console.log(JSON.stringify({node:process.version,platform:process.platform,arch:process.arch,cpu:os.cpus()[0]?.model,logicalCPUs:os.cpus().length,results:[bench(2),bench(40)],checksum,caveat:'Container synthetic Node pack+decode preallocated buffers, established dictionary. Excludes damage, parser, allocation, wire, rendering and physical latency.'},null,2));
