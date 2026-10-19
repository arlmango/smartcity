import { proxy } from "@/server/proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ path: string[] }> };

export async function GET(request: Request, ctx: Ctx): Promise<Response> {
  return proxy(request, (await ctx.params).path);
}

export async function POST(request: Request, ctx: Ctx): Promise<Response> {
  return proxy(request, (await ctx.params).path);
}
