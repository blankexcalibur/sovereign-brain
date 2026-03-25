import { logger } from '../utils/logger.js';

export class ASTParser {
  constructor() {
    this.Parser = null;
    this.langs = {};
    this.initialized = false;
  }

  async init() {
    if (this.initialized) return;
    try {
      const TreeSitter = (await import('tree-sitter')).default;
      this.Parser = new TreeSitter();
      
      const js = (await import('tree-sitter-javascript')).default;
      const ts = (await import('tree-sitter-typescript')).default.typescript;
      const tsx = (await import('tree-sitter-typescript')).default.tsx;
      const py = (await import('tree-sitter-python')).default;

      this.langs = {
        '.js': js,
        '.jsx': js,
        '.ts': ts,
        '.tsx': tsx,
        '.py': py
      };
      
      this.initialized = true;
      logger.info('Tree-Sitter AST Engine initialized successfully.');
    } catch (err) {
      logger.warn(`ASTParser initialization failed (using fallback regex): ${err.message}`);
      this.initialized = false;
    }
  }

  isSupported(ext) {
    return this.initialized && !!this.langs[ext];
  }

  /**
   * Traverse the AST to find high-level architectural blocks
   * @param {string} code The source code
   * @param {string} ext The file extension (.js, .ts, .py)
   * @returns {string[]} Array of code chunks strictly containing full function/class definitions
   */
  parseBlocks(code, ext) {
    if (!this.isSupported(ext)) return [];

    try {
      this.Parser.setLanguage(this.langs[ext]);
      const tree = this.Parser.parse(code);
      const blocks = [];

      const walk = (node) => {
        // JavaScript / TypeScript syntax nodes
        if (
          node.type === 'function_declaration' ||
          node.type === 'class_declaration' ||
          node.type === 'method_definition' ||
          node.type === 'lexical_declaration' || // for const/let arrows
          node.type === 'variable_declaration' || // for const/let arrows
          node.type === 'export_statement'
        ) {
          // If it's a variable declaration, ensure it contains an arrow function or function expression
          if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
            const text = node.text;
            if (text.includes('=>') || text.includes('function')) {
              blocks.push(text);
            }
          } else {
            blocks.push(node.text);
          }
        }
        
        // Python syntax nodes
        if (node.type === 'function_definition' || node.type === 'class_definition') {
          blocks.push(node.text);
        }

        // Only traverse children if we haven't already captured the full block
        // to avoid duplicate nested functions (unless desired, but here we want high-level)
        if (
          node.type !== 'function_declaration' &&
          node.type !== 'class_declaration' &&
          node.type !== 'method_definition' &&
          node.type !== 'function_definition' &&
          node.type !== 'class_definition'
        ) {
          for (let i = 0; i < node.childCount; i++) {
            walk(node.child(i));
          }
        }
      };

      walk(tree.rootNode);

      // Filter and deduplicate
      const uniqueBlocks = [...new Set(blocks)];
      return uniqueBlocks.filter(b => b.length > 50 && b.length < 10000);
    } catch (err) {
      logger.warn(`Tree-Sitter parse error on ${ext}: ${err.message}`);
      return [];
    }
  }
}
