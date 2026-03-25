import { parentPort } from 'worker_threads';
import { MemoryRepository } from '../repository.js';
import { AdaptiveEngine } from '../engines/adaptiveEngine.js';

// The worker gets its own completely isolated SQLite WAL connection
const repository = new MemoryRepository();
const adaptive = new AdaptiveEngine(repository);

parentPort.on('message', async (msg) => {
  try {
    if (msg.type === 'cluster') {
      const result = adaptive.cluster();
      parentPort.postMessage({ success: true, result });
    } else {
      throw new Error(`Unknown worker message type: ${msg.type}`);
    }
  } catch (error) {
    parentPort.postMessage({ success: false, error: error.message });
  }
});
