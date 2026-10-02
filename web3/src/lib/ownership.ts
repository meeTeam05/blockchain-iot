export function addressesMatch(left?: string, right?: string) {
  return Boolean(left && right && left.toLowerCase() === right.toLowerCase())
}
