"""Actual SDK, localhost only, synthetic credentials; no cloud session creation."""
import asyncio
from types import SimpleNamespace
from aiohttp import web
from das_python.live import LiveContext, create_sdk_client, _prompt_frames


def test_current_sdk_survives_twenty_two_second_idle_gap(monkeypatch):
    for key in ("HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"):
        monkeypatch.delenv(key, raising=False)
    async def run():
        requests = []
        async def stream(request):
            requests.append(True)
            await request.read()
            response = web.StreamResponse(headers={"Content-Type": "text/event-stream"})
            await response.prepare(request)
            await response.write(b'data: {"Jsonrpc":"2.0","Method":"session/update","Params":{}}\n\n')
            await asyncio.sleep(22)
            await response.write(b'data: {"Jsonrpc":"2.0","Result":{"stopReason":"end_turn"}}\n\n')
            await response.write_eof()
            return response
        app = web.Application()
        app.router.add_post("/", stream)
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, "127.0.0.1", 0)
        await site.start()
        port = site._server.sockets[0].getsockname()[1]
        cfg = SimpleNamespace(accessKeyId="synthetic", accessKeySecret="synthetic", regionId="cn-hangzhou", endpoint=f"127.0.0.1:{port}")
        client = create_sdk_client(cfg)
        client._protocol = "http"
        try:
            frames = [frame async for frame in _prompt_frames(LiveContext(client, cfg), "synthetic", "synthetic", [])]
            assert frames[-1]["Result"]["stopReason"] == "end_turn"
            assert len(frames) == 2
            assert len(requests) == 1
        finally:
            await runner.cleanup()
    asyncio.run(asyncio.wait_for(run(), 30))
