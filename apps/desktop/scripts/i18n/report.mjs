function plural(count, singular, pluralValue = `${singular}s`) {
  return count === 1 ? singular : pluralValue
}

function formatLocation(finding) {
  return `${finding.file}:${finding.line}:${finding.column}`
}

function formatFinding(finding) {
  const suffix = finding.key ? ` ${finding.key}` : finding.text ? ` "${finding.text}"` : ''
  return `  ${formatLocation(finding)}${suffix}`
}

function firstItems(items, limit = 20) {
  return items.slice(0, limit)
}

function toJsonReport(result) {
  return {
    exitCode: result.exitCode,
    filesScanned: result.scan.files.length,
    usedKeyCount: result.scan.usedKeys.length,
    failures: {
      resourceErrors: result.resources.errors,
      unknownNamespaces: result.scan.unknownNamespaces,
      missingEnglishKeys: result.scan.missingKeys,
      untranslated: result.scan.untranslated,
      todoLimit: result.todoLimitFailure
    },
    warnings: {
      dynamicKeys: result.scan.dynamicKeyWarnings,
      missingLocales: result.localeWarnings,
      orphanEnglishKeys: {
        count: result.orphanEnglishKeys.length,
        sample: firstItems(result.orphanEnglishKeys)
      },
      todoCount: result.scan.todoCommentCount
    }
  }
}

export function formatJsonReport(result) {
  return `${JSON.stringify(toJsonReport(result), null, 2)}\n`
}

export function formatTextReport(result) {
  const lines = []
  const failureCount =
    result.resources.errors.length +
    result.scan.unknownNamespaces.length +
    result.scan.missingKeys.length +
    result.scan.untranslated.length +
    (result.todoLimitFailure ? 1 : 0)

  lines.push(
    `ok: ${result.scan.usedKeys.length} ${plural(result.scan.usedKeys.length, 'key')} used across ${result.scan.files.length} ${plural(result.scan.files.length, 'file')}`
  )

  if (result.scan.missingKeys.length === 0 && result.scan.unknownNamespaces.length === 0) {
    lines.push('ok: all referenced keys exist in en/* bundles')
  }

  for (const localeWarning of result.localeWarnings) {
    if (localeWarning.missing.length > 0) {
      lines.push(
        `warn: ${localeWarning.missing.length} ${plural(localeWarning.missing.length, 'key')} missing in ${localeWarning.locale}/* (will fall back to en)`
      )
    }
  }

  if (result.orphanEnglishKeys.length > 0) {
    lines.push(
      `warn: ${result.orphanEnglishKeys.length} English ${plural(result.orphanEnglishKeys.length, 'key')} not referenced by scanned source`
    )
  }

  if (result.scan.dynamicKeyWarnings.length > 0) {
    lines.push(
      `warn: ${result.scan.dynamicKeyWarnings.length} dynamic translation ${plural(result.scan.dynamicKeyWarnings.length, 'key')} skipped`
    )
  }

  if (result.scan.todoCommentCount > 0) {
    lines.push(
      `warn: ${result.scan.todoCommentCount} TODO(i18n) ${plural(result.scan.todoCommentCount, 'straggler')} remain. Pass --max-todo ${result.scan.todoCommentCount} to freeze this count.`
    )
  }

  if (result.resources.errors.length > 0) {
    lines.push(
      `error: ${result.resources.errors.length} locale resource ${plural(result.resources.errors.length, 'error')}`
    )
    for (const error of result.resources.errors) {
      lines.push(`  ${error.file}: ${error.message}`)
    }
  }

  if (result.scan.unknownNamespaces.length > 0) {
    lines.push(
      `error: ${result.scan.unknownNamespaces.length} unknown ${plural(result.scan.unknownNamespaces.length, 'namespace')}`
    )
    lines.push(...result.scan.unknownNamespaces.map(formatFinding))
  }

  if (result.scan.missingKeys.length > 0) {
    lines.push(
      `error: ${result.scan.missingKeys.length} missing English ${plural(result.scan.missingKeys.length, 'key')}`
    )
    lines.push(...result.scan.missingKeys.map(formatFinding))
  }

  if (result.scan.untranslated.length > 0) {
    lines.push(
      `error: ${result.scan.untranslated.length} untranslated ${plural(result.scan.untranslated.length, 'string')}`
    )
    lines.push(...result.scan.untranslated.map(formatFinding))
  }

  if (result.todoLimitFailure) {
    lines.push(
      `error: TODO(i18n) count ${result.todoLimitFailure.actual} exceeds --max-todo ${result.todoLimitFailure.max}`
    )
  }

  if (failureCount === 0) {
    lines.push('ok: i18n check passed')
  }

  return `${lines.join('\n')}\n`
}
