import { handleWhoisRequest } from "../../_lib/whois.js";

export function onRequest(context) {
  return handleWhoisRequest(context.request, context.env);
}
