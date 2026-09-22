import assert from 'node:assert/strict';
import {checkHealth} from '../src/health-check.js';
for (const [status,expected] of [['UP',true],['DOWN',false],['UNKNOWN',false]]) {
  const result=await checkHealth('http://127.0.0.1/health',async()=>({ok:true,json:async()=>({status})}));
  assert.equal(result.healthy,expected);
}
assert.equal((await checkHealth('http://127.0.0.1/health',async()=>({ok:false,status:404}))).reason,'HTTP 404');
assert.equal((await checkHealth('http://127.0.0.1/health',async()=>{throw new Error('连接失败');})).healthy,false);
console.log('健康检查状态测试通过');
