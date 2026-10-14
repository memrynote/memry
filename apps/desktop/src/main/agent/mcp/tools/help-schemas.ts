import { z } from 'zod'

/** Inputs of the tools that answer questions about using Memry from the bundled user guide. */
export const HELP_TOOL_SCHEMAS = {
  memry_help_search: {
    input: z.object({ query: z.string().min(1).max(200) }),
    description:
      "Search Memry's user guide for how to use a feature. Use it when the user asks how to do " +
      'something in Memry or whether Memry supports something. The guide is in English, so ' +
      'search with English feature words ("note calendar date", "pdf annotation"). Returns the ' +
      'best matching sections with a snippet; read one with memry_help_read.'
  },
  memry_help_read: {
    input: z.object({ page: z.string().min(1), section: z.string().min(1).optional() }),
    description:
      'Read a page of the Memry user guide, or one section of it with its subsections, by the ' +
      'page and section a memry_help_search result returned.'
  }
} as const
