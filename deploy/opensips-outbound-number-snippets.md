# Outbound dial-prefix stripping and optional prepending

The server-specific `opensips.cfg` remains excluded from Git. Apply these edits
to `/usr/local/etc/opensips/opensips.cfg`; do not replace the whole production
configuration. This changes only dial-prefix outbound calls, not inbound DID
routing, caller identity, registration, or caller-DID/no-prefix routing.

## 1. Apply the additive migration first

From the updated project directory on the SBC, back up the custom routing table:

```bash
backup_file=$(mktemp /var/tmp/prefix-mapping-before-prepend.XXXXXX.sql)
sudo mysqldump --single-transaction opensips prefix_mapping > "$backup_file"
```

Stop if the backup fails. Then apply:

```bash
sudo mysql opensips < database/migrations/006_outbound_add_prefix.sql
```

This adds only nullable `prefix_mapping.add_prefix` (32 characters), preserving
existing rows. No digits are added for NULL or empty values. The MariaDB migration
can be rerun. The web installer does not apply it automatically. Apply it to new
installations too: `prefix_mapping` is a pre-existing custom table, not created by
`database/schema.sql`.

## 2. Update `route[PREFIX_ROUTING]`

Before editing the active configuration, make a private backup and save its path:

```bash
config_backup=$(mktemp /var/tmp/opensips-before-prepend.XXXXXX.cfg)
sudo install -o root -g root -m 600 /usr/local/etc/opensips/opensips.cfg "$config_backup"
printf 'Configuration backup: %s\n' "$config_backup"
```

Keep the existing PBX policy lookup above this block. Replace everything from
`$var(cache_key) = "prefix:" + $avp(dialed_number);` through the final
`route(DISPATCHER,$avp(sipline_set_id));` in this route with the following. Keep
the route's closing brace. Remove BOTH old cache-hit branches and the old
cache-store block; do not leave them ahead of this lookup.

```opensips
# Read the complete rule once per initial call. Old prefix caches are bypassed
# so edits, including clearing a prepended value, apply to the next new call.
$avp(prefix) = NULL;
$avp(sipline_set_id) = NULL;
$avp(strip_prefix) = "0";
$avp(add_prefix) = NULL;
avp_db_query("SELECT prefix,sipline_set_id,CAST(COALESCE(strip_prefix,1) AS CHAR),COALESCE(add_prefix,'') FROM prefix_mapping WHERE '$(avp(dialed_number){s.escape.common})' LIKE CONCAT(prefix, '%') ORDER BY LENGTH(prefix) DESC,id ASC LIMIT 1", "$avp(prefix);$avp(sipline_set_id);$avp(strip_prefix);$avp(add_prefix)");

if ($avp(sipline_set_id) == NULL || $avp(sipline_set_id) == "") {
        if ($avp(pbx_outbound_mode) == "prefix_required") {
                send_reply(404,"Prefix required");
                exit;
        }
        route(OUTGOING_DID_ROUTING);
        return;
}

# Protect the SIP URI even if somebody edits the database outside the UI.
if ($avp(add_prefix) != NULL && $avp(add_prefix) != ""
                && $avp(add_prefix) != "<null>") {
        if (!($avp(add_prefix) =~ "^[+]?[0-9]*$")
                        || $(avp(add_prefix){s.len}) > 32) {
                xlog("L_ERR","[PREFIX_ROUTING]#$ci# Invalid add_prefix in outbound rule\n");
                send_reply(500,"Invalid outbound dial rule");
                exit;
        }
}
route(DISPATCHER,$avp(sipline_set_id));
```

At the start of `route[OUTGOING_DID_ROUTING]`, alongside its existing
`$avp(strip_prefix) = "0";`, also add:

```opensips
$avp(add_prefix) = NULL;
```

This deliberately adds one route-table lookup for every new prefix-based call,
instead of using the old per-called-number cache. Measure database latency and
call setup performance during a controlled rollout. Old `prefix:*` cache entries
can expire normally; no Redis flush is needed. No-prefix fallback is unchanged.
If this server has custom no-prefix policy code, preserve it.

## 3. Update `branch_route[OUTGOING_BRANCH_ROUTE]`

Find the existing number rewrite below the PAI selection. Replace the block
starting `if ($avp(strip_prefix) == NULL ...` through
`$rU = $avp(final_dialed_number);` with:

```opensips
# Rebuild from the ORIGINAL dialed number on every branch/authentication retry.
# Never prepend to the current $rU: that could add the value twice on a retry.
if ($avp(strip_prefix) == "1") {
        $avp(final_dialed_number) = $(avp(dialed_number){s.substr, $(avp(prefix){s.len}), 0});
} else {
        $avp(final_dialed_number) = $avp(dialed_number);
}
if ($avp(add_prefix) != NULL && $avp(add_prefix) != ""
                && $avp(add_prefix) != "<null>") {
        $avp(final_dialed_number) = $avp(add_prefix) + $avp(final_dialed_number);
}
$rU = $avp(final_dialed_number);
```

Keep the existing `pv_printf($avp(to_uri),"sip:$rU@$rd");` immediately afterward.
Do not change the surrounding From, PAI, digest-authentication or RTP code.

## 4. Validate, deploy and test

After applying both snippet edits:

```bash
sudo /usr/local/sbin/opensips -C -f /usr/local/etc/opensips/opensips.cfg
```

Only if validation succeeds, restart OpenSIPS during a maintenance window with
no active calls. Deploy the application from the updated checkout:

```bash
sudo systemctl restart opensips
sudo systemctl status opensips --no-pager
sudo bash scripts/deploy.sh
```

Refresh the browser. Add/edit an outbound route and set **Prepend digits**.
The order is: longest matching dial-prefix rule -> strip if enabled -> prepend.

| Dialed number | Dial prefix | Strip | Prepend | Sent to provider |
|---|---|---|---|---|
| `1238012345678` | `123` | Yes | `+234` | `+2348012345678` |
| `1238012345678` | `123` | Yes | blank | `8012345678` |
| `1238012345678` | `123` | No | `+234` | `+2341238012345678` |

Nothing automatically removes a national leading `0` or an existing country
code. For example, prepending `+234` to `080...` produces `+234080...`, not
`+23480...`. Choose the dial rule to match the provider's expected format.

Test a new call, a provider 401/407 authentication retry, an existing blank
route, and clearing a saved value back to blank. Check the provider-bound
Request-URI AND To header in sngrep/Homer. The prefix must appear exactly once
on the authenticated retry as well as the first INVITE. Existing dialogs should
not be used to test new settings. No-prefix calls must keep their existing
number. The local Windows build cannot syntax-check or run OpenSIPS; validation
and SIP trace checks on the RHEL server are mandatory before production use.

If validation fails, do not restart. Restore the saved config or correct the
edits first. Keep the additive column when rolling back: it is harmless to the
previous application/config and dropping it would lose saved prepend settings.

OpenSIPS 3.4 documents the variable substring offset and SQL escaping used here
in its [script transformations reference](https://docs.opensips.org/manual/3-4/script-tran/).
