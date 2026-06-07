import json
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, urlparse
from urllib.request import Request, urlopen

PORT = 5500


def to_float(value):
    try:
        num = float(value)
        return num if num > 0 else 0.0
    except (TypeError, ValueError):
        return 0.0


def fetch_yahoo_json(path):
    last_error = None
    for host in ("query1", "query2"):
      url = f"https://{host}.finance.yahoo.com{path}"
      req = Request(url, headers={"User-Agent": "Mozilla/5.0"})
      try:
          with urlopen(req, timeout=12) as resp:
              return json.loads(resp.read().decode("utf-8"))
      except Exception as exc:
          last_error = exc
    raise last_error


class CuzzyHandler(SimpleHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/bist":
            self.handle_bist(parsed)
            return
        super().do_GET()

    def handle_bist(self, parsed):
        params = parse_qs(parsed.query)
        raw_symbols = params.get("symbols", [""])[0]
        symbols = [
            s.strip().upper()
            for s in raw_symbols.split(",")
            if s.strip() and s.strip().replace("_", "").isalnum()
        ]

        if not symbols:
            self.send_json(400, {"error": "symbols param required"})
            return

        prices = {}
        errors = []
        chunk_size = 20

        for i in range(0, len(symbols), chunk_size):
            chunk = symbols[i : i + chunk_size]
            yahoo_symbols = [f"{sym}.IS" for sym in chunk]
            query = quote(",".join(yahoo_symbols), safe="")

            data = None
            try:
                data = fetch_yahoo_json(f"/v7/finance/spark?symbols={query}&range=1d&interval=5m")
            except Exception as exc:
                errors.append(str(exc))

            if not data:
                continue

            results = data.get("spark", {}).get("result", [])
            for item in results:
                symbol = str(item.get("symbol", "")).upper()
                if not symbol.endswith(".IS"):
                    continue

                response = (item.get("response") or [{}])[0]
                meta = response.get("meta", {}) or {}
                price = to_float(meta.get("regularMarketPrice"))

                if price <= 0:
                    close_values = (
                        ((response.get("indicators") or {}).get("quote") or [{}])[0].get("close")
                        or []
                    )
                    for val in reversed(close_values):
                        price = to_float(val)
                        if price > 0:
                            break

                if price > 0:
                    prices[symbol.replace(".IS", "")] = price

        missing_symbols = [sym for sym in symbols if sym not in prices]
        for sym in missing_symbols:
            try:
                data = fetch_yahoo_json(f"/v8/finance/chart/{sym}.IS?range=1d&interval=5m")
                result = ((data.get("chart") or {}).get("result") or [None])[0]
                meta = ((result or {}).get("meta") or {})
                price = to_float(meta.get("regularMarketPrice"))
                if price <= 0:
                    close_values = ((((result or {}).get("indicators") or {}).get("quote") or [{}])[0].get("close") or [])
                    for val in reversed(close_values):
                        price = to_float(val)
                        if price > 0:
                            break
                if price > 0:
                    prices[sym] = price
            except Exception as exc:
                errors.append(str(exc))

        status = 200 if prices else 502
        self.send_json(
            status,
            {
                "prices": prices,
                "count": len(prices),
                "requested": len(symbols),
                "source": "yahoo-spark-via-local-proxy",
                "ok": len(prices) > 0,
                "errorCount": len(errors),
            },
        )

    def send_json(self, status_code, payload):
        body = json.dumps(payload, ensure_ascii=True).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", PORT), CuzzyHandler)
    print(f"Cuzzy server running on http://127.0.0.1:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
