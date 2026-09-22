const dependencyUrl = new URL('../../src/host-dependencies.js', import.meta.url).href;
export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  if (result.url === dependencyUrl) {
    return { url: new URL('./dependencies.mjs', import.meta.url).href, shortCircuit: true };
  }
  return result;
}
