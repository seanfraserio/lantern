/**
 * Escapes template markers in user-controlled content to prevent prompt injection.
 *
 * When user/agent content contains literal `{{input}}`, `{{output}}`, or `{{context}}`
 * strings, a naive `.replace()` chain will substitute those tokens during template
 * expansion — allowing the content to manipulate the judge prompt. This function
 * must be applied to every user-supplied string BEFORE template substitution.
 */
export function escapeTemplateMarkers(text: string): string {
  return text
    .replace(/\{\{input\}\}/g, "{ {input} }")
    .replace(/\{\{output\}\}/g, "{ {output} }")
    .replace(/\{\{context\}\}/g, "{ {context} }");
}
