import { pipeline, env } from '@xenova/transformers';

// Configure transformers to only use local models and skip cloud checks if preferred.
// For initial download, it must reach Hugging Face, but caches locally in ~/.cache/huggingface/
env.allowLocalModels = true;
env.useBrowserCache = false; // Node environment

const VECTOR_DIM = 384;
const HNSW_MAX_ELEMENTS = 100000;

export class EmbeddingEngine {
  constructor() {
    this.modelName = 'Xenova/all-MiniLM-L6-v2';
    this.pipelinePromise = null;
    this.hnswIndex = null;
    this.hnswIdMap = new Map(); // internal HNSW label -> memory ID
    this.hnswNextLabel = 0;
    this.hnswAvailable = false;
  }

  /**
   * Lazily initialize the embedding pipeline the first time it's needed.
   * This prevents high startup time if the user never runs semantic search.
   */
  async initPipeline() {
    if (!this.pipelinePromise) {
      this.pipelinePromise = pipeline('feature-extraction', this.modelName, {
        quantized: true, // INT8 quantization for rapid ~22MB loads
      });
    }
    return this.pipelinePromise;
  }

  /**
   * Initialize the HNSW index. Silently falls back to linear scan if hnswlib-node is unavailable.
   */
  async initHnsw() {
    if (this.hnswIndex) return true;
    try {
      const { HierarchicalNSW } = await import('hnswlib-node');
      this.hnswIndex = new HierarchicalNSW('cosine', VECTOR_DIM);
      this.hnswIndex.initIndex(HNSW_MAX_ELEMENTS, 16, 200, 100);
      this.hnswAvailable = true;
      return true;
    } catch (err) {
      this.hnswAvailable = false;
      return false;
    }
  }

  /**
   * Add a vector to the HNSW index, mapping the internal label to the memory ID.
   * @param {number} memoryId - The SQLite memory ID
   * @param {Array<number>} vector - The 384-dim embedding vector
   */
  addToIndex(memoryId, vector) {
    if (!this.hnswAvailable || !this.hnswIndex || !vector || vector.length !== VECTOR_DIM) return;
    try {
      const label = this.hnswNextLabel++;
      this.hnswIndex.addPoint(vector, label);
      this.hnswIdMap.set(label, memoryId);
    } catch (_) { /* silently skip if index is full */ }
  }

  /**
   * Bulk-load existing vectors from the database into the HNSW index.
   * Call this once after daemon boot with all existing embeddings.
   * @param {Array<{id: number, embedding: Array<number>}>} items
   */
  async bulkLoadIndex(items) {
    const ok = await this.initHnsw();
    if (!ok) return 0;
    let loaded = 0;
    for (const item of items) {
      if (item.embedding && item.embedding.length === VECTOR_DIM) {
        this.addToIndex(item.id, item.embedding);
        loaded++;
      }
    }
    return loaded;
  }

  /**
   * Fast approximate nearest-neighbor search using HNSW.
   * Returns array of { memoryId, distance } sorted by proximity.
   * Falls back to null if HNSW is unavailable.
   */
  searchKnn(queryVector, k = 10) {
    if (!this.hnswAvailable || !this.hnswIndex || this.hnswNextLabel === 0) return null;
    if (!queryVector || queryVector.length !== VECTOR_DIM) return null;

    try {
      const result = this.hnswIndex.searchKnn(queryVector, Math.min(k, this.hnswNextLabel));
      const neighbors = [];
      for (let i = 0; i < result.neighbors.length; i++) {
        const label = result.neighbors[i];
        const memoryId = this.hnswIdMap.get(label);
        if (memoryId !== undefined) {
          neighbors.push({
            memoryId,
            distance: result.distances[i],
            score: 1 - result.distances[i], // Convert cosine distance to similarity
          });
        }
      }
      return neighbors.sort((a, b) => b.score - a.score);
    } catch (_) {
      return null;
    }
  }

  /**
   * Generates a 384-dimensional dense Float32Array embedding for the given text.
   */
  async embed(text) {
    if (!text || typeof text !== 'string') return null;
    try {
      const extractor = await this.initPipeline();
      const output = await extractor(text, { pooling: 'mean', normalize: true });
      return Array.from(output.data); // Return regular array for JSON serialization
    } catch (error) {
      console.error('Embedding generation failed:', error);
      return null;
    }
  }

  /**
   * Computes mathematical cosine similarity between two JSON vectors.
   * For dot products where vectors are normalized, dot product === cosine distance.
   */
  vectorCosineSimilarity(vecA, vecB) {
    if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
    
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    
    for (let i = 0; i < vecA.length; i++) {
        dotProduct += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    
    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }
}

