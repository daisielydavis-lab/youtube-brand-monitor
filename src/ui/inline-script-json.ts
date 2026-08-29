/**
 * Safe serialization for embedding data into an inline <script> block.
 *
 * `JSON.stringify` already escapes control characters (0x00-0x1f, incl. LF / CR
 * / TAB) and `"`. In an HTML `<script>` context that is not enough, so this
 * layer additionally escapes the characters that are hazardous specifically
 * there (each escape decodes back to the original character on JS parse, so
 * data round-trips losslessly through JSON.parse):
 *
 *   `<`     -> `\\u003c`   prevents `</script>` breakout and HTML tag parsing
 *   `>`     -> `\\u003e`   symmetric, defensive
 *   `&`     -> `\\u0026`   defense-in-depth against entity interpretation
 *   U+2028  -> `\\u2028`   JS line separator — "unterminated string literal"
 *   U+2029  -> `\\u2029`   JS paragraph separator
 *
 * Raw YouTube titles are kept verbatim in the DB (source fidelity for audit /
 * reconciliation). This helper is the single choke point that makes them safe
 * for script embedding — every inline-script data injection in the dashboard
 * must go through it, never a bare `${JSON.stringify(data)}`.
 */
export function safeJsonForInlineScript(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(new RegExp(String.fromCharCode(0x2028), 'g'), '\\u2028')
    .replace(new RegExp(String.fromCharCode(0x2029), 'g'), '\\u2029');
}
