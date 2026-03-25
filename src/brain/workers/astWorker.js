import { parentPort } from 'worker_threads';

// Offload heavy AST Syntax string extraction away from the V8 Main Thread
// This prevents the Daemon API / VS Code Extension from dropping HTTP checks while processing massive codebase drops
function chunkSource(code, ext) {
  if (ext === '.md') return [code.slice(0, 4000)];
  
  const chunks = [];
  const blockRegex = /(class\s+\w+|function\s+\w+|const\s+\w+\s*=\s*(?:async\s*)?(?:function|\([^)]*\)\s*=>))/g;
  
  let match;
  let lastIndex = 0;
  while ((match = blockRegex.exec(code)) !== null) {
    if (lastIndex !== match.index && lastIndex !== 0) {
      chunks.push(code.slice(lastIndex, match.index).trim());
    }
    lastIndex = match.index;
  }
  
  if (lastIndex < code.length) {
    chunks.push(code.slice(lastIndex).trim());
  }
  
  return chunks.filter(c => c.length > 50 && c.length < 5000).slice(0, 20); // Cap to 20 blocks per file
}

parentPort.on('message', (job) => {
  try {
    const result = chunkSource(job.code, job.ext);
    parentPort.postMessage({ id: job.id, chunks: result });
  } catch (err) {
    parentPort.postMessage({ id: job.id, error: err.message });
  }
});
