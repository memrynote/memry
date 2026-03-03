/**
 * Expression Parser Tests
 *
 * Tests for the expression parser that converts expression strings into AST.
 * Covers tokenization, parsing, operator precedence, and error handling.
 *
 * @module lib/expression-parser.test
 */

import { describe, it, expect } from 'vitest'
import {
  parseExpression,
  validateExpression,
  ParseError,
  type ASTNode,
  type LiteralNode,
  type IdentifierNode,
  type MemberNode,
  type BinaryNode,
  type UnaryNode,
  type CallNode,
  type ConditionalNode
} from './expression-parser'

// ============================================================================
// T016: Test Structure and Basic Setup
// ============================================================================

describe('expression-parser', () => {
  describe('parseExpression', () => {
    it('should be a function', () => {
      expect(typeof parseExpression).toBe('function')
    })

    it('should return an ASTNode', () => {
      const result = parseExpression('42')
      expect(result).toBeDefined()
      expect(result.type).toBe('literal')
    })
  })

  // ==========================================================================
  // T017: Tokenizer - Numeric Literals, String Literals, Identifiers
  // ==========================================================================

  describe('tokenizer - literals', () => {
    describe('numeric literals', () => {
      it('should parse integer literals', () => {
        const result = parseExpression('42') as LiteralNode
        expect(result.type).toBe('literal')
        expect(result.value).toBe(42)
      })

      it('should parse zero', () => {
        const result = parseExpression('0') as LiteralNode
        expect(result.type).toBe('literal')
        expect(result.value).toBe(0)
      })

      it('should parse large integers', () => {
        const result = parseExpression('9999999') as LiteralNode
        expect(result.type).toBe('literal')
        expect(result.value).toBe(9999999)
      })

      it('should parse floating point numbers', () => {
        const result = parseExpression('3.14') as LiteralNode
        expect(result.type).toBe('literal')
        expect(result.value).toBe(3.14)
      })

      it('should parse floating point starting with dot', () => {
        const result = parseExpression('.5') as LiteralNode
        expect(result.type).toBe('literal')
        expect(result.value).toBe(0.5)
      })

      it('should parse floating point with trailing zeros', () => {
        const result = parseExpression('1.00') as LiteralNode
        expect(result.type).toBe('literal')
        expect(result.value).toBe(1.0)
      })

      it('should handle multiple decimal points by stopping at second', () => {
        // "1.2.3" should parse as 1.2 followed by .3 (which causes error or member access)
        expect(() => parseExpression('1.2.3')).toThrow(ParseError)
      })
    })

    describe('string literals', () => {
      it('should parse double-quoted strings', () => {
        const result = parseExpression('"hello"') as LiteralNode
        expect(result.type).toBe('literal')
        expect(result.value).toBe('hello')
      })

      it('should parse single-quoted strings', () => {
        const result = parseExpression("'world'") as LiteralNode
        expect(result.type).toBe('literal')
        expect(result.value).toBe('world')
      })

      it('should parse empty strings', () => {
        const result = parseExpression('""') as LiteralNode
        expect(result.type).toBe('literal')
        expect(result.value).toBe('')
      })

      it('should parse strings with spaces', () => {
        const result = parseExpression('"hello world"') as LiteralNode
        expect(result.type).toBe('literal')
        expect(result.value).toBe('hello world')
      })

      it('should parse strings with escaped characters', () => {
        const result = parseExpression('"hello\\nworld"') as LiteralNode
        expect(result.type).toBe('literal')
        expect(result.value).toBe('hello\nworld')
      })

      it('should parse strings with escaped tab', () => {
        const result = parseExpression('"hello\\tworld"') as LiteralNode
        expect(result.type).toBe('literal')
        expect(result.value).toBe('hello\tworld')
      })

      it('should parse strings with escaped backslash', () => {
        const result = parseExpression('"hello\\\\world"') as LiteralNode
        expect(result.type).toBe('literal')
        expect(result.value).toBe('hello\\world')
      })

      it('should parse strings with escaped quotes', () => {
        const result = parseExpression('"hello\\"world"') as LiteralNode
        expect(result.type).toBe('literal')
        expect(result.value).toBe('hello"world')
      })

      it('should throw on unterminated strings', () => {
        expect(() => parseExpression('"hello')).toThrow(ParseError)
        expect(() => parseExpression('"hello')).toThrow(/[Uu]nterminated string/)
      })
    })

    describe('identifiers', () => {
      it('should parse simple identifiers', () => {
        const result = parseExpression('foo') as IdentifierNode
        expect(result.type).toBe('identifier')
        expect(result.name).toBe('foo')
      })

      it('should parse identifiers with underscores', () => {
        const result = parseExpression('foo_bar') as IdentifierNode
        expect(result.type).toBe('identifier')
        expect(result.name).toBe('foo_bar')
      })

      it('should parse identifiers starting with underscore', () => {
        const result = parseExpression('_private') as IdentifierNode
        expect(result.type).toBe('identifier')
        expect(result.name).toBe('_private')
      })

      it('should parse identifiers with numbers', () => {
        const result = parseExpression('foo123') as IdentifierNode
        expect(result.type).toBe('identifier')
        expect(result.name).toBe('foo123')
      })

      it('should parse uppercase identifiers', () => {
        const result = parseExpression('FOO_BAR') as IdentifierNode
        expect(result.type).toBe('identifier')
        expect(result.name).toBe('FOO_BAR')
      })

      it('should parse camelCase identifiers', () => {
        const result = parseExpression('fooBar') as IdentifierNode
        expect(result.type).toBe('identifier')
        expect(result.name).toBe('fooBar')
      })
    })
  })

  // ==========================================================================
  // T018: Tokenizer - Operators
  // ==========================================================================

  describe('tokenizer - operators', () => {
    describe('arithmetic operators', () => {
      it('should tokenize addition', () => {
        const result = parseExpression('1 + 2') as BinaryNode
        expect(result.type).toBe('binary')
        expect(result.operator).toBe('+')
      })

      it('should tokenize subtraction', () => {
        const result = parseExpression('5 - 3') as BinaryNode
        expect(result.type).toBe('binary')
        expect(result.operator).toBe('-')
      })

      it('should tokenize multiplication', () => {
        const result = parseExpression('4 * 2') as BinaryNode
        expect(result.type).toBe('binary')
        expect(result.operator).toBe('*')
      })

      it('should tokenize division', () => {
        const result = parseExpression('10 / 2') as BinaryNode
        expect(result.type).toBe('binary')
        expect(result.operator).toBe('/')
      })

      it('should tokenize modulo', () => {
        const result = parseExpression('10 % 3') as BinaryNode
        expect(result.type).toBe('binary')
        expect(result.operator).toBe('%')
      })

      it('should tokenize exponentiation', () => {
        const result = parseExpression('2 ** 3') as BinaryNode
        expect(result.type).toBe('binary')
        expect(result.operator).toBe('**')
      })
    })

    describe('comparison operators', () => {
      it('should tokenize equals', () => {
        const result = parseExpression('a == b') as BinaryNode
        expect(result.type).toBe('binary')
        expect(result.operator).toBe('==')
      })

      it('should tokenize not equals', () => {
        const result = parseExpression('a != b') as BinaryNode
        expect(result.type).toBe('binary')
        expect(result.operator).toBe('!=')
      })

      it('should tokenize less than', () => {
        const result = parseExpression('a < b') as BinaryNode
        expect(result.type).toBe('binary')
        expect(result.operator).toBe('<')
      })

      it('should tokenize greater than', () => {
        const result = parseExpression('a > b') as BinaryNode
        expect(result.type).toBe('binary')
        expect(result.operator).toBe('>')
      })

      it('should tokenize less than or equal', () => {
        const result = parseExpression('a <= b') as BinaryNode
        expect(result.type).toBe('binary')
        expect(result.operator).toBe('<=')
      })

      it('should tokenize greater than or equal', () => {
        const result = parseExpression('a >= b') as BinaryNode
        expect(result.type).toBe('binary')
        expect(result.operator).toBe('>=')
      })
    })

    describe('logical operators', () => {
      it('should tokenize logical AND', () => {
        const result = parseExpression('a && b') as BinaryNode
        expect(result.type).toBe('binary')
        expect(result.operator).toBe('&&')
      })

      it('should tokenize logical OR', () => {
        const result = parseExpression('a || b') as BinaryNode
        expect(result.type).toBe('binary')
        expect(result.operator).toBe('||')
      })

      it('should tokenize logical NOT', () => {
        const result = parseExpression('!a') as UnaryNode
        expect(result.type).toBe('unary')
        expect(result.operator).toBe('!')
      })
    })
  })

  // ==========================================================================
  // T019: Tokenizer - Parentheses, Brackets, Commas, Dots
  // ==========================================================================

  describe('tokenizer - special characters', () => {
    describe('parentheses', () => {
      it('should handle parenthesized expressions', () => {
        const result = parseExpression('(1 + 2)') as BinaryNode
        expect(result.type).toBe('binary')
        expect(result.operator).toBe('+')
      })

      it('should handle nested parentheses', () => {
        const result = parseExpression('((1 + 2))') as BinaryNode
        expect(result.type).toBe('binary')
        expect(result.operator).toBe('+')
      })

      it('should handle function call parentheses', () => {
        const result = parseExpression('foo()') as CallNode
        expect(result.type).toBe('call')
        expect(result.callee).toBe('foo')
      })
    })

    describe('commas', () => {
      it('should handle commas in function arguments', () => {
        const result = parseExpression('foo(1, 2, 3)') as CallNode
        expect(result.type).toBe('call')
        expect(result.arguments).toHaveLength(3)
      })
    })

    describe('dots', () => {
      it('should handle dot for member access', () => {
        const result = parseExpression('obj.prop') as MemberNode
        expect(result.type).toBe('member')
        expect(result.property).toBe('prop')
      })

      it('should handle chained member access', () => {
        const result = parseExpression('a.b.c') as MemberNode
        expect(result.type).toBe('member')
        expect(result.property).toBe('c')
        expect((result.object as MemberNode).property).toBe('b')
      })
    })

    describe('ternary operators', () => {
      it('should handle question mark and colon', () => {
        const result = parseExpression('a ? b : c') as ConditionalNode
        expect(result.type).toBe('conditional')
      })
    })
  })

  // ==========================================================================
  // T020: Tokenizer - Whitespace Handling and Edge Cases
  // ==========================================================================

  describe('tokenizer - whitespace and edge cases', () => {
    it('should handle leading whitespace', () => {
      const result = parseExpression('   42') as LiteralNode
      expect(result.value).toBe(42)
    })

    it('should handle trailing whitespace', () => {
      const result = parseExpression('42   ') as LiteralNode
      expect(result.value).toBe(42)
    })

    it('should handle multiple spaces between tokens', () => {
      const result = parseExpression('1    +    2') as BinaryNode
      expect(result.operator).toBe('+')
    })

    it('should handle tabs', () => {
      const result = parseExpression('1\t+\t2') as BinaryNode
      expect(result.operator).toBe('+')
    })

    it('should handle newlines', () => {
      const result = parseExpression('1\n+\n2') as BinaryNode
      expect(result.operator).toBe('+')
    })

    it('should handle mixed whitespace', () => {
      const result = parseExpression('  \t\n  42  \n\t  ') as LiteralNode
      expect(result.value).toBe(42)
    })

    it('should throw on empty expression', () => {
      expect(() => parseExpression('')).toThrow(ParseError)
    })

    it('should throw on whitespace-only expression', () => {
      expect(() => parseExpression('   ')).toThrow(ParseError)
    })

    it('should throw on unexpected characters', () => {
      expect(() => parseExpression('@')).toThrow(ParseError)
      expect(() => parseExpression('#')).toThrow(ParseError)
      expect(() => parseExpression('$')).toThrow(ParseError)
    })
  })

  // ==========================================================================
  // T021: Parser - Literal Expressions
  // ==========================================================================

  describe('parser - literal expressions', () => {
    describe('number literals', () => {
      it('should parse positive integers', () => {
        const result = parseExpression('42') as LiteralNode
        expect(result).toEqual({ type: 'literal', value: 42 })
      })

      it('should parse floating point', () => {
        const result = parseExpression('3.14159') as LiteralNode
        expect(result).toEqual({ type: 'literal', value: 3.14159 })
      })
    })

    describe('string literals', () => {
      it('should parse strings', () => {
        const result = parseExpression('"test"') as LiteralNode
        expect(result).toEqual({ type: 'literal', value: 'test' })
      })
    })

    describe('boolean literals', () => {
      it('should parse true', () => {
        const result = parseExpression('true') as LiteralNode
        expect(result).toEqual({ type: 'literal', value: true })
      })

      it('should parse false', () => {
        const result = parseExpression('false') as LiteralNode
        expect(result).toEqual({ type: 'literal', value: false })
      })
    })

    describe('null literal', () => {
      it('should parse null', () => {
        const result = parseExpression('null') as LiteralNode
        expect(result).toEqual({ type: 'literal', value: null })
      })
    })
  })

  // ==========================================================================
  // T022: Parser - Identifier Expressions
  // ==========================================================================

  describe('parser - identifier expressions', () => {
    it('should parse simple identifiers', () => {
      const result = parseExpression('myVar') as IdentifierNode
      expect(result).toEqual({ type: 'identifier', name: 'myVar' })
    })

    it('should parse snake_case identifiers', () => {
      const result = parseExpression('my_var') as IdentifierNode
      expect(result).toEqual({ type: 'identifier', name: 'my_var' })
    })

    it('should parse UPPER_CASE identifiers', () => {
      const result = parseExpression('MY_CONST') as IdentifierNode
      expect(result).toEqual({ type: 'identifier', name: 'MY_CONST' })
    })

    it('should distinguish identifiers from keywords', () => {
      // 'true', 'false', 'null' are keywords, not identifiers
      const trueResult = parseExpression('true') as LiteralNode
      expect(trueResult.type).toBe('literal')

      // But 'True' is an identifier
      const TrueResult = parseExpression('True') as IdentifierNode
      expect(TrueResult.type).toBe('identifier')
      expect(TrueResult.name).toBe('True')
    })
  })

  // ==========================================================================
  // T023: Parser - Member Access
  // ==========================================================================

  describe('parser - member access', () => {
    describe('dot notation', () => {
      it('should parse simple member access', () => {
        const result = parseExpression('obj.prop') as MemberNode
        expect(result.type).toBe('member')
        expect(result.property).toBe('prop')
        expect((result.object as IdentifierNode).name).toBe('obj')
      })

      it('should parse chained member access', () => {
        const result = parseExpression('a.b.c') as MemberNode
        expect(result.type).toBe('member')
        expect(result.property).toBe('c')

        const middle = result.object as MemberNode
        expect(middle.type).toBe('member')
        expect(middle.property).toBe('b')

        const base = middle.object as IdentifierNode
        expect(base.name).toBe('a')
      })

      it('should parse deeply nested member access', () => {
        const result = parseExpression('a.b.c.d.e') as MemberNode
        expect(result.property).toBe('e')
      })

      it('should parse member access on literals', () => {
        // This is valid syntax, even if semantically odd
        const result = parseExpression('"hello".length') as MemberNode
        expect(result.type).toBe('member')
        expect(result.property).toBe('length')
      })
    })

    describe('member access with function calls', () => {
      it('should NOT support method calls on member access (parser limitation)', () => {
        // The parser only supports function calls on identifiers, not member expressions
        // obj.method() is NOT valid - only standalone function calls like method() work
        expect(() => parseExpression('obj.method()')).toThrow(ParseError)
        expect(() => parseExpression('obj.method()')).toThrow(/Cannot call non-identifier/)
      })

      it('should support standalone function calls', () => {
        // This is the supported pattern - direct function calls
        const result = parseExpression('method()') as CallNode
        expect(result.type).toBe('call')
        expect(result.callee).toBe('method')
      })
    })
  })

  // ==========================================================================
  // T024: Parser - Binary Expressions with Correct Precedence
  // ==========================================================================

  describe('parser - binary expressions with precedence', () => {
    describe('arithmetic precedence', () => {
      it('should give * higher precedence than +', () => {
        // 1 + 2 * 3 should parse as 1 + (2 * 3)
        const result = parseExpression('1 + 2 * 3') as BinaryNode
        expect(result.operator).toBe('+')
        expect((result.left as LiteralNode).value).toBe(1)
        expect((result.right as BinaryNode).operator).toBe('*')
      })

      it('should give / higher precedence than -', () => {
        // 10 - 6 / 2 should parse as 10 - (6 / 2)
        const result = parseExpression('10 - 6 / 2') as BinaryNode
        expect(result.operator).toBe('-')
        expect((result.right as BinaryNode).operator).toBe('/')
      })

      it('should give ** higher precedence than *', () => {
        // 2 * 3 ** 2 should parse as 2 * (3 ** 2)
        const result = parseExpression('2 * 3 ** 2') as BinaryNode
        expect(result.operator).toBe('*')
        expect((result.right as BinaryNode).operator).toBe('**')
      })

      it('should handle left-to-right associativity for + and -', () => {
        // 1 - 2 + 3 should parse as (1 - 2) + 3
        const result = parseExpression('1 - 2 + 3') as BinaryNode
        expect(result.operator).toBe('+')
        expect((result.left as BinaryNode).operator).toBe('-')
      })

      it('should handle right-to-left associativity for **', () => {
        // 2 ** 3 ** 2 should parse as 2 ** (3 ** 2)
        const result = parseExpression('2 ** 3 ** 2') as BinaryNode
        expect(result.operator).toBe('**')
        expect((result.right as BinaryNode).operator).toBe('**')
      })
    })

    describe('comparison and logical precedence', () => {
      it('should give comparison operators lower precedence than arithmetic', () => {
        // 1 + 2 == 3 should parse as (1 + 2) == 3
        const result = parseExpression('1 + 2 == 3') as BinaryNode
        expect(result.operator).toBe('==')
        expect((result.left as BinaryNode).operator).toBe('+')
      })

      it('should give && higher precedence than ||', () => {
        // a || b && c should parse as a || (b && c)
        const result = parseExpression('a || b && c') as BinaryNode
        expect(result.operator).toBe('||')
        expect((result.right as BinaryNode).operator).toBe('&&')
      })

      it('should give comparison higher precedence than &&', () => {
        // a == b && c == d should parse as (a == b) && (c == d)
        const result = parseExpression('a == b && c == d') as BinaryNode
        expect(result.operator).toBe('&&')
        expect((result.left as BinaryNode).operator).toBe('==')
        expect((result.right as BinaryNode).operator).toBe('==')
      })
    })

    describe('parentheses override precedence', () => {
      it('should allow parentheses to override precedence', () => {
        // (1 + 2) * 3 should parse as (1 + 2) * 3
        const result = parseExpression('(1 + 2) * 3') as BinaryNode
        expect(result.operator).toBe('*')
        expect((result.left as BinaryNode).operator).toBe('+')
      })

      it('should handle nested parentheses', () => {
        const result = parseExpression('((1 + 2) * 3)') as BinaryNode
        expect(result.operator).toBe('*')
      })
    })
  })

  // ==========================================================================
  // T025: Parser - Unary Expressions
  // ==========================================================================

  describe('parser - unary expressions', () => {
    describe('logical NOT (!)', () => {
      it('should parse simple NOT', () => {
        const result = parseExpression('!a') as UnaryNode
        expect(result.type).toBe('unary')
        expect(result.operator).toBe('!')
        expect((result.argument as IdentifierNode).name).toBe('a')
      })

      it('should parse NOT on boolean literal', () => {
        const result = parseExpression('!true') as UnaryNode
        expect(result.type).toBe('unary')
        expect(result.operator).toBe('!')
        expect((result.argument as LiteralNode).value).toBe(true)
      })

      it('should parse double NOT', () => {
        const result = parseExpression('!!a') as UnaryNode
        expect(result.type).toBe('unary')
        expect(result.operator).toBe('!')
        expect((result.argument as UnaryNode).operator).toBe('!')
      })
    })

    describe('unary minus (-)', () => {
      it('should parse negative numbers', () => {
        const result = parseExpression('-42') as UnaryNode
        expect(result.type).toBe('unary')
        expect(result.operator).toBe('-')
        expect((result.argument as LiteralNode).value).toBe(42)
      })

      it('should parse negated identifiers', () => {
        const result = parseExpression('-x') as UnaryNode
        expect(result.type).toBe('unary')
        expect(result.operator).toBe('-')
        expect((result.argument as IdentifierNode).name).toBe('x')
      })

      it('should parse double negation', () => {
        const result = parseExpression('--x') as UnaryNode
        expect(result.type).toBe('unary')
        expect((result.argument as UnaryNode).operator).toBe('-')
      })
    })

    describe('unary with binary', () => {
      it('should give unary higher precedence than binary', () => {
        // -a + b should parse as (-a) + b
        const result = parseExpression('-a + b') as BinaryNode
        expect(result.operator).toBe('+')
        expect((result.left as UnaryNode).operator).toBe('-')
      })

      it('should handle NOT in boolean expression', () => {
        // !a && b should parse as (!a) && b
        const result = parseExpression('!a && b') as BinaryNode
        expect(result.operator).toBe('&&')
        expect((result.left as UnaryNode).operator).toBe('!')
      })
    })
  })

  // ==========================================================================
  // T026: Parser - Function Calls with Arguments
  // ==========================================================================

  describe('parser - function calls', () => {
    describe('no arguments', () => {
      it('should parse function call with no arguments', () => {
        const result = parseExpression('foo()') as CallNode
        expect(result.type).toBe('call')
        expect(result.callee).toBe('foo')
        expect(result.arguments).toEqual([])
      })

      it('should parse function call with whitespace', () => {
        const result = parseExpression('foo(  )') as CallNode
        expect(result.arguments).toEqual([])
      })
    })

    describe('single argument', () => {
      it('should parse with literal argument', () => {
        const result = parseExpression('foo(42)') as CallNode
        expect(result.type).toBe('call')
        expect(result.callee).toBe('foo')
        expect(result.arguments).toHaveLength(1)
        expect((result.arguments[0] as LiteralNode).value).toBe(42)
      })

      it('should parse with identifier argument', () => {
        const result = parseExpression('foo(bar)') as CallNode
        expect(result.arguments).toHaveLength(1)
        expect((result.arguments[0] as IdentifierNode).name).toBe('bar')
      })

      it('should parse with expression argument', () => {
        const result = parseExpression('foo(1 + 2)') as CallNode
        expect(result.arguments).toHaveLength(1)
        expect((result.arguments[0] as BinaryNode).operator).toBe('+')
      })
    })

    describe('multiple arguments', () => {
      it('should parse with two arguments', () => {
        const result = parseExpression('foo(1, 2)') as CallNode
        expect(result.arguments).toHaveLength(2)
      })

      it('should parse with three arguments', () => {
        const result = parseExpression('add(1, 2, 3)') as CallNode
        expect(result.arguments).toHaveLength(3)
      })

      it('should parse with mixed argument types', () => {
        const result = parseExpression('format(name, 42, true)') as CallNode
        expect(result.arguments).toHaveLength(3)
        expect((result.arguments[0] as IdentifierNode).name).toBe('name')
        expect((result.arguments[1] as LiteralNode).value).toBe(42)
        expect((result.arguments[2] as LiteralNode).value).toBe(true)
      })

      it('should parse with string arguments', () => {
        const result = parseExpression('format("hello", "world")') as CallNode
        expect(result.arguments).toHaveLength(2)
        expect((result.arguments[0] as LiteralNode).value).toBe('hello')
        expect((result.arguments[1] as LiteralNode).value).toBe('world')
      })
    })

    describe('nested function calls', () => {
      it('should parse nested function calls', () => {
        const result = parseExpression('outer(inner())') as CallNode
        expect(result.callee).toBe('outer')
        expect((result.arguments[0] as CallNode).callee).toBe('inner')
      })

      it('should parse deeply nested function calls', () => {
        const result = parseExpression('a(b(c(x)))') as CallNode
        expect(result.callee).toBe('a')
        const inner = result.arguments[0] as CallNode
        expect(inner.callee).toBe('b')
        const innermost = inner.arguments[0] as CallNode
        expect(innermost.callee).toBe('c')
      })
    })

    describe('function calls in expressions', () => {
      it('should parse function call result in binary expression', () => {
        const result = parseExpression('foo() + 1') as BinaryNode
        expect(result.operator).toBe('+')
        expect((result.left as CallNode).callee).toBe('foo')
      })

      it('should parse function call as argument', () => {
        const result = parseExpression('foo(bar(), baz())') as CallNode
        expect(result.arguments).toHaveLength(2)
        expect((result.arguments[0] as CallNode).callee).toBe('bar')
        expect((result.arguments[1] as CallNode).callee).toBe('baz')
      })
    })
  })

  // ==========================================================================
  // T027: Parser - Conditional (Ternary) Expressions
  // ==========================================================================

  describe('parser - conditional (ternary) expressions', () => {
    it('should parse simple ternary', () => {
      const result = parseExpression('a ? b : c') as ConditionalNode
      expect(result.type).toBe('conditional')
      expect((result.test as IdentifierNode).name).toBe('a')
      expect((result.consequent as IdentifierNode).name).toBe('b')
      expect((result.alternate as IdentifierNode).name).toBe('c')
    })

    it('should parse ternary with literal values', () => {
      const result = parseExpression('true ? 1 : 0') as ConditionalNode
      expect(result.type).toBe('conditional')
      expect((result.test as LiteralNode).value).toBe(true)
      expect((result.consequent as LiteralNode).value).toBe(1)
      expect((result.alternate as LiteralNode).value).toBe(0)
    })

    it('should parse ternary with comparison test', () => {
      const result = parseExpression('x > 0 ? "positive" : "non-positive"') as ConditionalNode
      expect(result.type).toBe('conditional')
      expect((result.test as BinaryNode).operator).toBe('>')
    })

    it('should parse nested ternary in consequent', () => {
      const result = parseExpression('a ? b ? c : d : e') as ConditionalNode
      expect(result.type).toBe('conditional')
      expect((result.consequent as ConditionalNode).type).toBe('conditional')
    })

    it('should parse nested ternary in alternate', () => {
      const result = parseExpression('a ? b : c ? d : e') as ConditionalNode
      expect(result.type).toBe('conditional')
      expect((result.alternate as ConditionalNode).type).toBe('conditional')
    })

    it('should parse ternary with function calls', () => {
      const result = parseExpression('isEmpty(x) ? default() : x') as ConditionalNode
      expect(result.type).toBe('conditional')
      expect((result.test as CallNode).callee).toBe('isEmpty')
      expect((result.consequent as CallNode).callee).toBe('default')
    })

    it('should parse ternary with complex expressions', () => {
      const result = parseExpression('a + b > c ? x * 2 : y / 2') as ConditionalNode
      expect(result.type).toBe('conditional')
      expect((result.test as BinaryNode).operator).toBe('>')
      expect((result.consequent as BinaryNode).operator).toBe('*')
      expect((result.alternate as BinaryNode).operator).toBe('/')
    })
  })

  // ==========================================================================
  // T028: Parser - Nested Expressions and Complex Combinations
  // ==========================================================================

  describe('parser - nested and complex expressions', () => {
    it('should parse complex arithmetic expression', () => {
      const result = parseExpression('(a + b) * (c - d) / e') as BinaryNode
      expect(result.operator).toBe('/')
    })

    it('should parse boolean expression with comparisons', () => {
      const result = parseExpression('x > 0 && x < 100 || y == null') as BinaryNode
      expect(result.operator).toBe('||')
    })

    it('should parse function call with complex arguments', () => {
      const result = parseExpression('format(a + b, c * d, e ? f : g)') as CallNode
      expect(result.arguments).toHaveLength(3)
    })

    it('should parse function call with ternary (without member method call)', () => {
      // Note: obj.method() is not supported, but standalone function calls work
      const result = parseExpression('check() ? a.b : c.d') as ConditionalNode
      expect(result.type).toBe('conditional')
      expect((result.test as CallNode).callee).toBe('check')
    })

    it('should parse deeply nested parentheses', () => {
      const result = parseExpression('(((a + b)))') as BinaryNode
      expect(result.operator).toBe('+')
    })

    it('should parse expression from example: price * quantity', () => {
      const result = parseExpression('price * quantity') as BinaryNode
      expect(result.type).toBe('binary')
      expect(result.operator).toBe('*')
      expect((result.left as IdentifierNode).name).toBe('price')
      expect((result.right as IdentifierNode).name).toBe('quantity')
    })

    it('should parse expression from example: dateDiff(due_date, today(), "days")', () => {
      const result = parseExpression('dateDiff(due_date, today(), "days")') as CallNode
      expect(result.type).toBe('call')
      expect(result.callee).toBe('dateDiff')
      expect(result.arguments).toHaveLength(3)
      expect((result.arguments[0] as IdentifierNode).name).toBe('due_date')
      expect((result.arguments[1] as CallNode).callee).toBe('today')
      expect((result.arguments[2] as LiteralNode).value).toBe('days')
    })

    it('should parse complex formula expression', () => {
      const result = parseExpression(
        'if(status == "complete", 100, progress * 100 / total)'
      ) as CallNode
      expect(result.type).toBe('call')
      expect(result.callee).toBe('if')
      expect(result.arguments).toHaveLength(3)
    })
  })

  // ==========================================================================
  // T029: Parser - Error Handling for Invalid Syntax
  // ==========================================================================

  describe('parser - error handling', () => {
    describe('empty and invalid input', () => {
      it('should throw on empty expression', () => {
        expect(() => parseExpression('')).toThrow(ParseError)
        expect(() => parseExpression('')).toThrow(/empty/)
      })

      it('should throw on null-like input', () => {
        expect(() => parseExpression(null as unknown as string)).toThrow()
        expect(() => parseExpression(undefined as unknown as string)).toThrow()
      })
    })

    describe('unbalanced parentheses', () => {
      it('should throw on missing closing parenthesis', () => {
        expect(() => parseExpression('(1 + 2')).toThrow(ParseError)
      })

      it('should throw on missing opening parenthesis', () => {
        expect(() => parseExpression('1 + 2)')).toThrow(ParseError)
      })

      it('should throw on mismatched parentheses', () => {
        expect(() => parseExpression('((1 + 2)')).toThrow(ParseError)
      })
    })

    describe('incomplete expressions', () => {
      it('should throw on trailing operator', () => {
        expect(() => parseExpression('1 +')).toThrow(ParseError)
      })

      it('should throw on leading binary operator', () => {
        expect(() => parseExpression('+ 1')).toThrow(ParseError)
      })

      it('should throw on missing ternary alternate', () => {
        expect(() => parseExpression('a ? b')).toThrow(ParseError)
      })

      it('should throw on incomplete ternary', () => {
        expect(() => parseExpression('a ? b :')).toThrow(ParseError)
      })

      it('should throw on missing function argument after comma', () => {
        expect(() => parseExpression('foo(1,)')).toThrow(ParseError)
      })
    })

    describe('invalid tokens', () => {
      it('should throw on unexpected characters', () => {
        expect(() => parseExpression('1 @ 2')).toThrow(ParseError)
      })

      it('should throw on unterminated string', () => {
        expect(() => parseExpression('"hello')).toThrow(ParseError)
      })
    })

    describe('semantic errors', () => {
      it('should throw on calling non-identifier', () => {
        expect(() => parseExpression('42()')).toThrow(ParseError)
        expect(() => parseExpression('"hello"()')).toThrow(ParseError)
      })
    })

    describe('ParseError properties', () => {
      it('should include position in error', () => {
        try {
          parseExpression('1 + @ 2')
          expect.fail('Should have thrown')
        } catch (e) {
          expect(e).toBeInstanceOf(ParseError)
          expect((e as ParseError).position).toBeDefined()
          expect(typeof (e as ParseError).position).toBe('number')
        }
      })

      it('should include descriptive message', () => {
        try {
          parseExpression('1 +')
          expect.fail('Should have thrown')
        } catch (e) {
          expect(e).toBeInstanceOf(ParseError)
          expect((e as ParseError).message).toBeTruthy()
        }
      })
    })
  })

  // ==========================================================================
  // T030: validateExpression() Function
  // ==========================================================================

  describe('validateExpression', () => {
    describe('valid expressions', () => {
      it('should return valid: true for valid expression', () => {
        const result = validateExpression('1 + 2')
        expect(result.valid).toBe(true)
        expect(result.error).toBeUndefined()
      })

      it('should return valid: true for complex expression', () => {
        const result = validateExpression('foo(bar, baz) ? a.b : c + d')
        expect(result.valid).toBe(true)
      })

      it('should return valid: true for all literals', () => {
        expect(validateExpression('42').valid).toBe(true)
        expect(validateExpression('"hello"').valid).toBe(true)
        expect(validateExpression('true').valid).toBe(true)
        expect(validateExpression('false').valid).toBe(true)
        expect(validateExpression('null').valid).toBe(true)
      })
    })

    describe('invalid expressions', () => {
      it('should return valid: false for empty expression', () => {
        const result = validateExpression('')
        expect(result.valid).toBe(false)
        expect(result.error).toBeDefined()
      })

      it('should return valid: false for syntax error', () => {
        const result = validateExpression('1 +')
        expect(result.valid).toBe(false)
        expect(result.error).toBeDefined()
      })

      it('should include position for parse errors', () => {
        const result = validateExpression('1 + @ 2')
        expect(result.valid).toBe(false)
        expect(result.position).toBeDefined()
        expect(typeof result.position).toBe('number')
      })

      it('should return error message for invalid input', () => {
        const result = validateExpression('((1 + 2)')
        expect(result.valid).toBe(false)
        expect(result.error).toContain('Expected')
      })
    })

    describe('edge cases', () => {
      it('should handle whitespace-only input', () => {
        const result = validateExpression('   ')
        expect(result.valid).toBe(false)
      })

      it('should not throw - returns result object instead', () => {
        // validateExpression should never throw, always return result
        expect(() => validateExpression('')).not.toThrow()
        expect(() => validateExpression('invalid @#$ syntax')).not.toThrow()
      })
    })
  })
})
