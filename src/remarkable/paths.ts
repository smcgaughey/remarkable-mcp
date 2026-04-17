// Resolve a user-facing folder path like "/Inbox" or "/Books/Papers" to the
// reMarkable document UUID used as the parent on uploads. Root folder is
// represented by empty string "".
//
// TODO: implement. Needs to fetch the current document index (root blob),
// walk entries looking for folders matching each path segment. If the target
// doesn't exist, either create it or fail — decide per caller.
//
// For the MVP we can skip resolution and always upload to root, then have the
// user manually move to /Inbox. We'll tackle folder resolution in v0.2.

export async function resolveFolder(_path: string): Promise<string> {
  return ''; // root
}
