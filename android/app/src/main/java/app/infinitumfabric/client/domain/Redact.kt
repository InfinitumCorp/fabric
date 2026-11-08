package app.infinitumfabric.client.domain

fun redact(line: String): String {
    return line
        .replace(Regex("""@[A-Za-z0-9._=\-/]+:[A-Za-z0-9.\-]+"""), "[user]")
        .replace(Regex("""@[a-z0-9_]{2,24}\.veil"""), "[handle]")
        .replace(Regex("""\b(syt|syr|mat)_[A-Za-z0-9_\-]+"""), "[token]")
        .replace(Regex("""Bearer\s+\S+""", RegexOption.IGNORE_CASE), "Bearer [token]")
        .replace(Regex("""(body|password|key)=("[^"]*"|\S+)""", RegexOption.IGNORE_CASE), "$1=[redacted]")
}
