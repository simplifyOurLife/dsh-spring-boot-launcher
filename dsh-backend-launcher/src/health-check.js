// HTTP 可访问与应用健康分开判断，Actuator DOWN 不能因 HTTP 200 被误判。
export async function checkHealth(url, fetcher = fetch) {
  try {
    const response = await fetcher(url, {signal:AbortSignal.timeout(3000), redirect:'error'});
    if (!response.ok) return {healthy:false, reason:`HTTP ${response.status}`};
    const body = await response.json();
    return {healthy:body.status === 'UP', reason:`Actuator ${body.status || '状态缺失'}`};
  } catch (error) { return {healthy:false, reason:error.message}; }
}
