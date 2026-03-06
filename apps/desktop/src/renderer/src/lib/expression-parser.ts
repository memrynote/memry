/**
 * Expression Parser for Formula Columns
 *
 * Parses expression strings into an Abstract Syntax Tree (AST).
 * Supports operators, function calls, property access, and literals.
 *
 * @module lib/expression-parser
 */

// ============================================================================
// AST Node Types
// ============================================================================

export type ASTNode =
  | LiteralNode
  | IdentifierNode
  | MemberNode
  | BinaryNode
  | UnaryNode
  | CallNode
  | ConditionalNode

export interface LiteralNode {
  type: 'literal'
  value: string | number | boolean | null
}

export interface IdentifierNode {
  type: 'identifier'
  name: string
}

export interface MemberNode {
  type: 'member'
  object: ASTNode
  property: string
}

export interface BinaryNode {
  type: 'binary'
  operator: string
  left: ASTNode
  right: ASTNode
}

export interface UnaryNode {
  type: 'unary'
  operator: string
  argument: ASTNode
}

export interface CallNode {
  type: 'call'
  callee: string
  arguments: ASTNode[]
}

export interface ConditionalNode {
  type: 'conditional'
  test: ASTNode
  consequent: ASTNode
  alternate: ASTNode
}

// ============================================================================
// Token Types
// ============================================================================

type TokenType =
  | 'number'
  | 'string'
  | 'identifier'
  | 'operator'
  | 'lparen'
  | 'rparen'
  | 'comma'
  | 'dot'
  | 'question'
  | 'colon'
  | 'eof'

interface Token {
  type: TokenType
  value: string
  position: number
}

// ============================================================================
// Parse Error
// ============================================================================

export class ParseError extends Error {
  constructor(
    message: string,
    public position: number
  ) {
    super(message)
    this.name = 'ParseError'
  }
}

// ============================================================================
// Tokenizer
// ============================================================================

const OPERATORS = ['||', '&&', '==', '!=', '<=', '>=', '<', '>', '+', '-', '*', '/', '%', '**', '!']

/**
 * Tokenize an expression string into tokens.
 */
function tokenize(expression: string): Token[] {
  const tokens: Token[] = []
  let pos = 0

  while (pos < expression.length) {
    // Skip whitespace
    if (/\s/.test(expression[pos])) {
      pos++
      continue
    }

    const startPos = pos
    const char = expression[pos]

    // Number
    if (/\d/.test(char) || (char === '.' && /\d/.test(expression[pos + 1] || ''))) {
      let num = ''
      let hasDot = false
      while (pos < expression.length && (/\d/.test(expression[pos]) || expression[pos] === '.')) {
        if (expression[pos] === '.') {
          if (hasDot) break
          hasDot = true
        }
        num += expression[pos]
        pos++
      }
      tokens.push({ type: 'number', value: num, position: startPos })
      continue
    }

    // String (double or single quotes)
    if (char === '"' || char === "'") {
      const quote = char
      pos++ // skip opening quote
      let str = ''
      while (pos < expression.length && expression[pos] !== quote) {
        if (expression[pos] === '\\' && pos + 1 < expression.length) {
          pos++
          const escaped = expression[pos]
          switch (escaped) {
            case 'n':
              str += '\n'
              break
            case 't':
              str += '\t'
              break
            case '\\':
              str += '\\'
              break
            case '"':
              str += '"'
              break
            case "'":
              str += "'"
              break
            default:
              str += escaped
          }
        } else {
          str += expression[pos]
        }
        pos++
      }
      if (pos >= expression.length) {
        throw new ParseError(`Unterminated string starting at position ${startPos}`, startPos)
      }
      pos++ // skip closing quote
      tokens.push({ type: 'string', value: str, position: startPos })
      continue
    }

    // Identifier or keyword (true, false, null)
    if (/[a-zA-Z_]/.test(char)) {
      let ident = ''
      while (pos < expression.length && /[a-zA-Z0-9_]/.test(expression[pos])) {
        ident += expression[pos]
        pos++
      }
      tokens.push({ type: 'identifier', value: ident, position: startPos })
      continue
    }

    // Multi-character operators
    const twoChar = expression.slice(pos, pos + 2)
    if (OPERATORS.includes(twoChar)) {
      tokens.push({ type: 'operator', value: twoChar, position: startPos })
      pos += 2
      continue
    }

    // Single-character operators
    if (OPERATORS.includes(char)) {
      tokens.push({ type: 'operator', value: char, position: startPos })
      pos++
      continue
    }

    // Special characters
    switch (char) {
      case '(':
        tokens.push({ type: 'lparen', value: '(', position: startPos })
        pos++
        continue
      case ')':
        tokens.push({ type: 'rparen', value: ')', position: startPos })
        pos++
        continue
      case ',':
        tokens.push({ type: 'comma', value: ',', position: startPos })
        pos++
        continue
      case '.':
        tokens.push({ type: 'dot', value: '.', position: startPos })
        pos++
        continue
      case '?':
        tokens.push({ type: 'question', value: '?', position: startPos })
        pos++
        continue
      case ':':
        tokens.push({ type: 'colon', value: ':', position: startPos })
        pos++
        continue
    }

    throw new ParseError(`Unexpected character '${char}' at position ${pos}`, pos)
  }

  tokens.push({ type: 'eof', value: '', position: pos })
  return tokens
}

// ============================================================================
// Parser
// ============================================================================

/**
 * Operator precedence (lower number = lower precedence, binds less tightly)
 */
const PRECEDENCE: Record<string, number> = {
  '||': 1,
  '&&': 2,
  '==': 3,
  '!=': 3,
  '<': 4,
  '>': 4,
  '<=': 4,
  '>=': 4,
  '+': 5,
  '-': 5,
  '*': 6,
  '/': 6,
  '%': 6,
  '**': 7
}

/**
 * Right-associative operators
 */
const RIGHT_ASSOC = new Set(['**'])

/**
 * Parser class using precedence climbing for binary operators.
 */
class Parser {
  private tokens: Token[]
  private pos = 0

  constructor(tokens: Token[]) {
    this.tokens = tokens
  }

  /**
   * Get current token.
   */
  private current(): Token {
    return this.tokens[this.pos]
  }

  /**
   * Advance to next token and return the previous one.
   */
  private advance(): Token {
    const token = this.current()
    if (token.type !== 'eof') {
      this.pos++
    }
    return token
  }

  /**
   * Check if current token matches expected type and value.
   */
  private match(type: TokenType, value?: string): boolean {
    const token = this.current()
    if (token.type !== type) return false
    if (value !== undefined && token.value !== value) return false
    return true
  }

  /**
   * Expect current token to match and advance, or throw error.
   */
  private expect(type: TokenType, value?: string): Token {
    const token = this.current()
    if (token.type !== type || (value !== undefined && token.value !== value)) {
      const expected = value ? `'${value}'` : type
      throw new ParseError(
        `Expected ${expected} but got '${token.value}' at position ${token.position}`,
        token.position
      )
    }
    return this.advance()
  }

  /**
   * Parse the expression.
   */
  parse(): ASTNode {
    const node = this.parseExpression()
    if (this.current().type !== 'eof') {
      throw new ParseError(
        `Unexpected token '${this.current().value}' at position ${this.current().position}`,
        this.current().position
      )
    }
    return node
  }

  /**
   * Parse expression with ternary operator support.
   */
  private parseExpression(): ASTNode {
    return this.parseTernary()
  }

  /**
   * Parse ternary conditional: test ? consequent : alternate
   */
  private parseTernary(): ASTNode {
    let node = this.parseBinary(0)

    if (this.match('question')) {
      this.advance() // consume '?'
      const consequent = this.parseExpression()
      this.expect('colon')
      const alternate = this.parseExpression()
      node = {
        type: 'conditional',
        test: node,
        consequent,
        alternate
      }
    }

    return node
  }

  /**
   * Parse binary expression with precedence climbing.
   */
  private parseBinary(minPrec: number): ASTNode {
    let left = this.parseUnary()

    while (true) {
      const token = this.current()
      if (token.type !== 'operator') break

      const prec = PRECEDENCE[token.value]
      if (prec === undefined || prec < minPrec) break

      this.advance() // consume operator
      const op = token.value

      // Handle right-associativity
      const nextMinPrec = RIGHT_ASSOC.has(op) ? prec : prec + 1
      const right = this.parseBinary(nextMinPrec)

      left = {
        type: 'binary',
        operator: op,
        left,
        right
      }
    }

    return left
  }

  /**
   * Parse unary expression: !expr, -expr
   */
  private parseUnary(): ASTNode {
    const token = this.current()

    if (token.type === 'operator' && (token.value === '!' || token.value === '-')) {
      this.advance()
      const argument = this.parseUnary()
      return {
        type: 'unary',
        operator: token.value,
        argument
      }
    }

    return this.parsePostfix()
  }

  /**
   * Parse postfix expressions: function calls and member access.
   */
  private parsePostfix(): ASTNode {
    let node = this.parsePrimary()

    while (true) {
      if (this.match('lparen')) {
        // Function call
        if (node.type !== 'identifier') {
          throw new ParseError(
            `Cannot call non-identifier at position ${this.current().position}`,
            this.current().position
          )
        }
        this.advance() // consume '('
        const args: ASTNode[] = []

        if (!this.match('rparen')) {
          args.push(this.parseExpression())
          while (this.match('comma')) {
            this.advance() // consume ','
            args.push(this.parseExpression())
          }
        }

        this.expect('rparen')
        node = {
          type: 'call',
          callee: node.name,
          arguments: args
        }
      } else if (this.match('dot')) {
        // Member access
        this.advance() // consume '.'
        const propToken = this.expect('identifier')
        node = {
          type: 'member',
          object: node,
          property: propToken.value
        }
      } else {
        break
      }
    }

    return node
  }

  /**
   * Parse primary expression: literals, identifiers, parenthesized.
   */
  private parsePrimary(): ASTNode {
    const token = this.current()

    // Number literal
    if (token.type === 'number') {
      this.advance()
      const value = token.value.includes('.') ? parseFloat(token.value) : parseInt(token.value, 10)
      return { type: 'literal', value }
    }

    // String literal
    if (token.type === 'string') {
      this.advance()
      return { type: 'literal', value: token.value }
    }

    // Identifier or keyword
    if (token.type === 'identifier') {
      this.advance()

      // Handle keywords
      if (token.value === 'true') {
        return { type: 'literal', value: true }
      }
      if (token.value === 'false') {
        return { type: 'literal', value: false }
      }
      if (token.value === 'null') {
        return { type: 'literal', value: null }
      }

      return { type: 'identifier', name: token.value }
    }

    // Parenthesized expression
    if (token.type === 'lparen') {
      this.advance() // consume '('
      const expr = this.parseExpression()
      this.expect('rparen')
      return expr
    }

    throw new ParseError(
      `Unexpected token '${token.value}' at position ${token.position}`,
      token.position
    )
  }
}

// ============================================================================
// Main Export
// ============================================================================

/**
 * Parse an expression string into an AST.
 *
 * @param expression - The expression string to parse
 * @returns The root AST node
 * @throws {ParseError} If the expression is invalid
 *
 * @example
 * parseExpression('price * quantity')
 * // => { type: 'binary', operator: '*', left: {...}, right: {...} }
 *
 * @example
 * parseExpression('dateDiff(due_date, today(), "days")')
 * // => { type: 'call', callee: 'dateDiff', arguments: [...] }
 */
export function parseExpression(expression: string): ASTNode {
  if (!expression || !expression.trim()) {
    throw new ParseError('Expression cannot be empty', 0)
  }

  const tokens = tokenize(expression.trim())
  const parser = new Parser(tokens)
  return parser.parse()
}

/**
 * Check if an expression is valid without throwing.
 *
 * @param expression - The expression string to validate
 * @returns Object with valid flag and optional error message
 */
export function validateExpression(expression: string): {
  valid: boolean
  error?: string
  position?: number
} {
  try {
    parseExpression(expression)
    return { valid: true }
  } catch (err) {
    if (err instanceof ParseError) {
      return { valid: false, error: err.message, position: err.position }
    }
    return { valid: false, error: String(err) }
  }
}

export default parseExpression
