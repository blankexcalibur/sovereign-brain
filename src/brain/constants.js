export const DIMENSIONS = {
  COGNITIVE: 'cognitive',
  CODE: 'code',
  TASK: 'task',
  CONTEXT: 'context',
  EPISODIC: 'episodic',
};

export const VALID_DIMENSIONS = new Set(Object.values(DIMENSIONS));

export const DEFAULTS = {
  importance: 0.5,
  decayFactor: 0.985,
  limit: 10,
  dbFileName: 'brain.db',
  compressionThreshold: 500,
  clusterSimilarityThreshold: 0.30,
  maxTokenBudget: 3200,
  tokensPerChar: 0.25,
};

export const RELATION_TYPES = {
  SIMILAR_CONCEPT: 'similar_concept',
  BUG_FIX_PAIR: 'bug_fix_pair',
  BUILDS_ON: 'builds_on',
  PREREQUISITE: 'prerequisite',
  SUPERSEDES: 'supersedes',
  PART_OF: 'part_of',
  CAUSED_BY: 'caused_by',
};

export const COMPRESSION_LEVELS = {
  NONE: 0,
  LIGHT: 1,
  HEAVY: 2,
};

export const SCORING_WEIGHTS = {
  relevance: 0.40,
  importance: 0.25,
  recency: 0.20,
  usage: 0.15,
};

export const PATTERN_CATEGORIES = {
  LANGUAGES: {
    js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
    py: 'python', go: 'go',
    rs: 'rust', java: 'java', rb: 'ruby', cpp: 'cpp', c: 'c',
    cs: 'csharp', php: 'php', swift: 'swift', kt: 'kotlin',
    scala: 'scala', ex: 'elixir', hs: 'haskell', lua: 'lua',
    sh: 'shell', ps1: 'powershell', sql: 'sql',
    html: 'html', css: 'css', scss: 'scss', vue: 'vue', svelte: 'svelte',
  },
  FRAMEWORKS: [
    { pattern: /\b(react|jsx|tsx|usestate|useeffect|useref)\b/i, tag: 'react' },
    { pattern: /\b(express|fastify|koa|hapi)\b/i, tag: 'node-server' },
    { pattern: /\b(next\.?js|getstaticprops|getserversideprops)\b/i, tag: 'nextjs' },
    { pattern: /\b(django|flask|fastapi)\b/i, tag: 'python-web' },
    { pattern: /\b(spring|springboot)\b/i, tag: 'spring' },
    { pattern: /\b(vue|vuex|pinia|nuxt)\b/i, tag: 'vue' },
    { pattern: /\b(angular|rxjs|ngrx)\b/i, tag: 'angular' },
    { pattern: /\b(tailwind|bootstrap|material.?ui)\b/i, tag: 'css-framework' },
    { pattern: /\b(prisma|sequelize|typeorm|knex|drizzle)\b/i, tag: 'orm' },
    { pattern: /\b(docker|kubernetes|k8s|helm)\b/i, tag: 'containers' },
    { pattern: /\b(aws|gcp|azure|cloudflare)\b/i, tag: 'cloud' },
    { pattern: /\b(graphql|apollo|relay)\b/i, tag: 'graphql' },
    { pattern: /\b(redis|memcached)\b/i, tag: 'caching' },
    { pattern: /\b(mongodb|mongoose|postgres|mysql|sqlite)\b/i, tag: 'database' },
    { pattern: /\b(jest|mocha|vitest|pytest|junit)\b/i, tag: 'testing' },
    { pattern: /\b(webpack|vite|esbuild|rollup|parcel)\b/i, tag: 'bundler' },
    { pattern: /\b(ci\/cd|github.?actions|gitlab.?ci|jenkins)\b/i, tag: 'ci-cd' },
  ],
  ARCHITECTURE: [
    { pattern: /\b(api|endpoint|route|controller|handler)\b/i, tag: 'api' },
    { pattern: /\b(middleware|interceptor|guard)\b/i, tag: 'middleware' },
    { pattern: /\b(auth|jwt|oauth|session|login|signup)\b/i, tag: 'auth' },
    { pattern: /\b(migration|schema|model|entity)\b/i, tag: 'data-model' },
    { pattern: /\b(queue|worker|job|cron|scheduler)\b/i, tag: 'async-jobs' },
    { pattern: /\b(websocket|socket\.io|sse|realtime)\b/i, tag: 'realtime' },
    { pattern: /\b(cache|memoize|invalidat)\b/i, tag: 'caching-pattern' },
    { pattern: /\b(microservice|monolith|event.?driven|saga)\b/i, tag: 'architecture' },
  ],
  COMPLEXITY: [
    { pattern: /\basync\b.*\bawait\b|\bPromise\b|\bcallback\b/i, tag: 'async' },
    { pattern: /\brecursi(ve|on)\b/i, tag: 'recursion' },
    { pattern: /\bconcurren(t|cy)\b|\bparallel\b|\bthread\b|\batomic\b/i, tag: 'concurrency' },
    { pattern: /\bstream\b|\bpipe\b|\btransform\b/i, tag: 'streaming' },
    { pattern: /\bgeneric[s]?\b|\btemplate\b|\bpolymorphi/i, tag: 'generics' },
  ],
};
