// The shapes Nox shares between its pages.
//
// The tracker's own types live beside it in components/nox/model.ts — this file
// is for what the shell needs, which is essentially "who is signed in".

export interface User {
  id: number;
  username: string;
  email: string;
  /** admin | member. Admins approve registrations and change project settings. */
  role: string;
  /** pending | approved | suspended | banned. Registration is a request. */
  status: string;
  createdAt: number;
  nickname: string;
  avatar: string;
  /** Account tags, kept from the app Nox grew out of. Nothing gates on them
   *  today — Nox is one product, not five behind one login — but they are the
   *  natural place for per-feature access if that changes. */
  tags: string[];
}
