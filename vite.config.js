import dns from "node:dns";
import https from "node:https";

// the system resolver sometimes fails on archive.org's dnXXXX nodes
// (ENOTFOUND) while plain DNS works: fall back to dns.resolve4
function lookup(hostname, options, cb) {
  if (typeof options === "function") [cb, options] = [options, {}];
  dns.lookup(hostname, options, (err, address, family) => {
    if (!err) return cb(null, address, family);
    dns.resolve4(hostname, (err4, addrs) => {
      if (err4 || !addrs.length) return cb(err);
      if (options.all) cb(null, addrs.map((a) => ({ address: a, family: 4 })));
      else cb(null, addrs[0], 4);
    });
  });
}

// archive.org video files have no CORS headers, so proxy them through the
// dev server to keep them same-origin (needed for VideoFrame in datamosh.html)
export default {
  server: {
    proxy: {
      "/ia": {
        target: "https://archive.org",
        changeOrigin: true,
        followRedirects: true,
        agent: new https.Agent({ keepAlive: true, lookup }),
        rewrite: (path) => path.replace(/^\/ia/, ""),
      },
    },
  },
};
