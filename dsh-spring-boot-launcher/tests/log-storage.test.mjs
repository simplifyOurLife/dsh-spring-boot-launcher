import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,statSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openLogFile,appendLog,closeLog} from '../src/log-storage.js';
const dir=mkdtempSync(join(tmpdir(),'dsh-log-storage-'));
const opened=openLogFile(dir);
assert.ok(opened.path.endsWith('dsh-spring-boot-launcher.log'));
const entry={logFd:opened.fd,handle:{logPath:opened.path},logBuffer:''};
try {
  appendLog(entry,'\x1b[31mhello\x1b[0m');
  assert.equal(readFileSync(opened.path,'utf8'),'hello');
  appendLog(entry,'x'.repeat(10*1024*1024));
  assert.equal(readFileSync(opened.path+'.1','utf8'),'hello');
  assert.ok(statSync(opened.path).size<=10*1024*1024);
  assert.ok(entry.logBuffer.length<=512*1024);
  closeLog(entry);
  assert.equal(entry.logFd,null);
  closeLog(entry);
} finally {closeLog(entry);rmSync(dir,{recursive:true,force:true});}
console.log('日志轮转与句柄释放测试通过');
