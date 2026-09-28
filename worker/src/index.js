/* TuneTeasers Worker: the public JioSaavn search proxy (saavn.js), the
   private group sync API backed by D1 (group.js), personal tickets
   (people.js) and buzz-in rooms, one Durable Object each (rooms.js, room.js). */
import { SAAVN_ROUTES, saavn, publicJson } from "./saavn.js";
import { group, isGroupPath } from "./group.js";
import { people, isPeoplePath } from "./people.js";
import { rooms, isRoomPath } from "./rooms.js";

export { Room } from "./room.js";

export default {
  async fetch(request, env, ctx){
    const url = new URL(request.url);
    if (isGroupPath(url.pathname)) return group(request, env, url, ctx);
    if (isPeoplePath(url.pathname)) return people(request, env, url, ctx);
    if (isRoomPath(url.pathname)) return rooms(request, env, url);
    if (url.pathname === "/health") return publicJson({ success: true });
    const handler = SAAVN_ROUTES[url.pathname];
    if (handler) return saavn(request, handler, ctx);
    return publicJson({ success: false, message: "not found" }, 404);
  },};
