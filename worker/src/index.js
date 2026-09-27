/* TuneTeasers Worker: the public JioSaavn search proxy (saavn.js) and the
   private group sync API backed by D1 (group.js). */
import { SAAVN_ROUTES, saavn, publicJson } from "./saavn.js";
import { group, isGroupPath } from "./group.js";

export default {
  async fetch(request, env, ctx){
    const url = new URL(request.url);
    if (isGroupPath(url.pathname)) return group(request, env, url, ctx);
    if (url.pathname === "/health") return publicJson({ success: true });
    const handler = SAAVN_ROUTES[url.pathname];
    if (handler) return saavn(request, handler, ctx);
    return publicJson({ success: false, message: "not found" }, 404);
  },};
