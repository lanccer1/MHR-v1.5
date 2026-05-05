#!/usr/bin/env python3
"""
DomainFront Tunnel — Bypass DPI censorship via GAS + Cloudflare Workers.
Multi-GAS support added (version 1.5)
"""

import argparse
import asyncio
import json
import logging
import os
import sys

_SRC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "src")
if _SRC_DIR not in sys.path:
    sys.path.insert(0, _SRC_DIR)

from cert_installer import install_ca, uninstall_ca, is_ca_trusted
from constants import __version__
from lan_utils import log_lan_access
from google_ip_scanner import scan_sync
from logging_utils import configure as configure_logging, print_banner
from mitm import CA_CERT_FILE
from proxy_server import ProxyServer


def setup_logging(level_name: str):
    configure_logging(level_name)


_PLACEHOLDER_AUTH_KEYS = {"", "CHANGE_ME_TO_A_STRONG_SECRET", "your-secret-password-here"}


def parse_args():
    parser = argparse.ArgumentParser(prog="domainfront-tunnel")
    parser.add_argument("-c", "--config", default=os.environ.get("DFT_CONFIG", "config.json"))
    parser.add_argument("-p", "--port", type=int, default=None)
    parser.add_argument("--host", default=None)
    parser.add_argument("--socks5-port", type=int, default=None)
    parser.add_argument("--disable-socks5", action="store_true")
    parser.add_argument("--log-level", choices=["DEBUG", "INFO", "WARNING", "ERROR"], default=None)
    parser.add_argument("-v", "--version", action="version", version=f"%(prog)s {__version__}")
    parser.add_argument("--install-cert", action="store_true")
    parser.add_argument("--uninstall-cert", action="store_true")
    parser.add_argument("--no-cert-check", action="store_true")
    parser.add_argument("--scan", action="store_true")
    return parser.parse_args()


def main():
    args = parse_args()

    if args.install_cert or args.uninstall_cert:
        setup_logging("INFO")
        _log = logging.getLogger("Main")
        if args.install_cert:
            _log.info("Installing CA certificate…")
            if not os.path.exists(CA_CERT_FILE):
                from mitm import MITMCertManager
                MITMCertManager()
            ok = install_ca(CA_CERT_FILE)
            sys.exit(0 if ok else 1)
        _log.info("Removing CA certificate…")
        ok = uninstall_ca(CA_CERT_FILE)
        sys.exit(0 if ok else 1)

    config_path = args.config
    try:
        with open(config_path) as f:
            config = json.load(f)
    except FileNotFoundError:
        print(f"Config not found: {config_path}")
        print("Run: python setup.py   or copy config.example.json to config.json")
        sys.exit(1)
    except json.JSONDecodeError as e:
        print(f"Invalid JSON in config: {e}")
        sys.exit(1)

    # Environment overrides
    if os.environ.get("DFT_AUTH_KEY"):
        config["auth_key"] = os.environ["DFT_AUTH_KEY"]
    if os.environ.get("DFT_SCRIPT_ID"):
        config["script_id"] = os.environ["DFT_SCRIPT_ID"]

    # CLI overrides
    if args.port is not None:
        config["listen_port"] = args.port
    if args.host is not None:
        config["listen_host"] = args.host
    if args.socks5_port is not None:
        config["socks5_port"] = args.socks5_port
    if args.disable_socks5:
        config["socks5_enabled"] = False
    if args.log_level is not None:
        config["log_level"] = args.log_level

    # Multi-GAS Support
    script_ids = config.get("script_ids") or config.get("script_id")
    if isinstance(script_ids, str):
        config["script_ids"] = [script_ids.strip()]
    elif isinstance(script_ids, list):
        config["script_ids"] = [sid.strip() for sid in script_ids if sid and str(sid).strip()]
    else:
        print("Error: 'script_ids' (list) or 'script_id' (string) is required in config.json")
        sys.exit(1)

    if not config["script_ids"]:
        print("Error: No valid script_id / script_ids found.")
        sys.exit(1)

    if config.get("auth_key", "") in _PLACEHOLDER_AUTH_KEYS:
        print("Error: auth_key is not set properly. Change it to a strong secret.")
        sys.exit(1)

    config["mode"] = "apps_script"

    setup_logging(config.get("log_level", "INFO"))
    log = logging.getLogger("Main")

    print_banner(__version__)
    log.info(f"DomainFront Tunnel v{__version__} - Multi-GAS Enabled")
    log.info(f"Using {len(config['script_ids'])} Google Apps Script(s)")

    for i, sid in enumerate(config["script_ids"]):
        short = sid[:15] + "..." + sid[-8:] if len(sid) > 25 else sid
        log.info(f"  GAS [{i+1}] → {short}")

    # Auto CA install
    if not os.path.exists(CA_CERT_FILE):
        from mitm import MITMCertManager
        MITMCertManager()

    if not args.no_cert_check:
        if not is_ca_trusted(CA_CERT_FILE):
            log.warning("MITM CA not trusted — installing...")
            install_ca(CA_CERT_FILE)
        else:
            log.info("MITM CA is trusted.")

    # LAN sharing
    lan_sharing = config.get("lan_sharing", False)
    listen_host = config.get("listen_host", "127.0.0.1")
    if lan_sharing and listen_host == "127.0.0.1":
        config["listen_host"] = "0.0.0.0"

    lan_mode = lan_sharing or config["listen_host"] in ("0.0.0.0", "::")
    if lan_mode:
        log_lan_access(config.get("listen_port", 8080),
                       config.get("socks5_port", 1080) if config.get("socks5_enabled") else None)

    try:
        asyncio.run(_run(config))
    except KeyboardInterrupt:
        log.info("Stopped by user")


async def _run(config):
    server = ProxyServer(config)
    try:
        await server.start()
    finally:
        await server.stop()


if __name__ == "__main__":
    main()