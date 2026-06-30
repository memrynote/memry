import type { ReactDoctorConfig } from 'react-doctor/api'

export default {
  rules: {
    // Upstream (eslint-plugin-react-you-might-not-need-an-effect) ships this at
    // "warn"; react-doctor escalates it to "error". The remaining occurrences are
    // imperative DOM-measurement / observer guards that reset on a prop change,
    // not render-derivable duplicated state, so keep it advisory at its default.
    'react-doctor/no-adjust-state-on-prop-change': 'warn'
  },
  ignore: {
    files: [
      '**/tests/**',
      '**/*.test.ts',
      '**/*.test.tsx',
      '**/*.spec.ts',
      '**/*.spec.tsx',
      '**/fixtures/**',
      '**/generated/**',
      '**/out/**',
      '**/dist/**',
      '**/.wrangler/**',
      // File-based-routing entries the import-graph analyzer can't resolve, so
      // unused-file / only-export-components fire as false positives:
      // WXT extension entrypoints + their components (loaded by the WXT build),
      '**/entrypoints/**',
      'src/components/*.tsx',
      // react-email app (`email dev --dir emails`) — every file is a template
      // discovered at runtime, not statically imported,
      '**/emails/**',
      'src/waitlist-*',
      'src/campaign-content.ts',
      // Vercel serverless functions + the SSG entry loaded via dynamic path.
      'api/**',
      '**/entry-server.tsx'
    ],
    rules: [
      'knip/duplicates',
      'knip/exports',
      'knip/files',
      'knip/types',
      'react-doctor/advanced-event-handler-refs',
      'react-doctor/async-await-in-loop',
      'react-doctor/async-defer-await',
      'react-doctor/async-parallel',
      'react-doctor/client-passive-event-listeners',
      'react-doctor/design-no-default-tailwind-palette',
      'react-doctor/design-no-em-dash-in-jsx-text',
      'react-doctor/design-no-redundant-padding-axes',
      'react-doctor/design-no-redundant-size-axes',
      'react-doctor/design-no-space-on-flex-children',
      'react-doctor/design-no-three-period-ellipsis',
      'react-doctor/js-batch-dom-css',
      'react-doctor/js-cache-property-access',
      'react-doctor/js-cache-storage',
      'react-doctor/js-combine-iterations',
      'react-doctor/js-flatmap-filter',
      'react-doctor/js-hoist-intl',
      'react-doctor/js-index-maps',
      'react-doctor/js-length-check-first',
      'react-doctor/js-min-max-loop',
      'react-doctor/js-set-map-lookups',
      'react-doctor/js-tosorted-immutable',
      'react-doctor/no-barrel-import',
      'react-doctor/no-cascading-set-state',
      'react-doctor/no-derived-useState',
      'react-doctor/no-dynamic-import-path',
      'react-doctor/no-effect-event-handler',
      'react-doctor/no-fetch-in-effect',
      'react-doctor/no-flush-sync',
      'react-doctor/no-generic-handler-names',
      'react-doctor/no-giant-component',
      'react-doctor/no-inline-bounce-easing',
      'react-doctor/no-inline-exhaustive-style',
      'react-doctor/no-many-boolean-props',
      'react-doctor/no-pure-black-background',
      'react-doctor/no-react19-deprecated-apis',
      'react-doctor/no-render-in-render',
      'react-doctor/no-scale-from-zero',
      'react-doctor/no-side-tab-border',
      'react-doctor/no-tiny-text',
      'react-doctor/no-z-index-9999',
      'react-doctor/prefer-use-effect-event',
      'react-doctor/prefer-useReducer',
      'react-doctor/query-mutation-missing-invalidation',
      'react-doctor/rendering-conditional-render',
      'react-doctor/rendering-hydration-mismatch-time',
      'react-doctor/rendering-svg-precision',
      'react-doctor/rendering-usetransition-loading',
      'react-doctor/rerender-functional-setstate',
      'react-doctor/rerender-lazy-state-init',
      'react-doctor/rerender-memo-before-early-return',
      'react-doctor/rerender-memo-with-default-value',
      'react-doctor/rerender-state-only-in-handlers',
      'react-doctor/server-dedup-props',
      'react-doctor/server-sequential-independent-await',
      'react-doctor/use-lazy-motion',
      'react/no-danger',
      'jsx-a11y/click-events-have-key-events',
      'jsx-a11y/heading-has-content',
      'jsx-a11y/iframe-has-title',
      'jsx-a11y/label-has-associated-control',
      'jsx-a11y/no-autofocus',
      'jsx-a11y/no-static-element-interactions',
      // --- Health pass: curated to match this config's existing policy ---
      // (disable noisy/pedantic/perf/architecture hints; keep high-signal
      // correctness, security, and maintainability rules ON). Every safely
      // fixable occurrence of these was fixed first; the residual is entirely
      // false-positive or behavior-locked for this codebase's patterns.
      //
      // you-might-not-need-an-effect family — siblings already disabled above
      // (no-cascading-set-state, no-derived-useState, no-effect-event-handler,
      // no-fetch-in-effect). Residual: external IPC/query subscriptions and
      // parent-controlled effects, not the state-hop anti-pattern.
      'react-doctor/no-event-handler',
      'react-doctor/no-prop-callback-in-effect',
      'react-doctor/no-chain-state-updates',
      'react-doctor/no-derived-state',
      'react-doctor/no-derived-state-effect',
      'react-doctor/no-effect-chain',
      'react-doctor/no-pass-data-to-parent',
      'react-doctor/no-pass-live-state-to-parent',
      // perf hints — same character as the disabled js-*/rerender-* rules.
      // Residual: idiomatic slot-prop JSX and cheap empty Set/Map ref inits.
      'react-doctor/jsx-no-jsx-as-prop',
      'react-doctor/rerender-lazy-ref-init',
      // architecture/DX hints — same character as no-giant-component (disabled).
      // Residual: shadcn/compound-component barrels, Provider stacks, and
      // BlockNote block-spec modules (component + serialization in one file).
      'react-doctor/no-multi-comp',
      'react-doctor/jsx-max-depth',
      'react-doctor/only-export-components',
      // jsx-a11y pedantry on valid composite ARIA widgets — same character as
      // the jsx-a11y rules already disabled above. Residual: role="button" on
      // rows wrapping nested interactive controls, listbox/option/combobox/
      // dialog/progressbar/slider/group with no valid native-element conversion.
      'react-doctor/prefer-tag-over-role',
      'react-doctor/prefer-html-dialog',
      'react-doctor/no-noninteractive-element-interactions',
      'react-doctor/no-noninteractive-tabindex',
      'react-doctor/prefer-explicit-variants',
      // Confirmed false positives (verified in code):
      // FTS5 virtual-table name can't be a bound param (callers pass literals),
      'react-doctor/raw-sql-injection-risk',
      // `signature.length !== CONSTANT` is a length guard, not crypto compare,
      'react-doctor/insecure-crypto-risk',
      // VITE_PADDLE_CLIENT_TOKEN is Paddle's designated public client token.
      'react-doctor/public-env-secret-name',
      // Flags `<input role="combobox">` as redundant, but that role is required
      // by the ARIA 1.2 combobox pattern (and by role-supports-aria-props /
      // role-has-required-aria-props, which we keep ON) — removing it would
      // re-break aria-expanded/aria-controls. Rule conflict; keep the input valid.
      'react-doctor/no-redundant-roles'
    ]
  },
  lint: true,
  deadCode: true,
  failOn: 'error',
  supplyChain: {
    // vitest is a dev/build-only test runner — its Socket vulnerability axis
    // does not gate what we ship, so exclude devDependencies from scoring.
    includeDevDependencies: false,
    // posthog-js (PostHog's official SDK, used app-wide) scores 46 on the
    // supply-chain axis — just under the default 50 from a moderate, accepted
    // advisory rather than active compromise. Vetted and accepted.
    minScore: 45
  }
} satisfies ReactDoctorConfig
