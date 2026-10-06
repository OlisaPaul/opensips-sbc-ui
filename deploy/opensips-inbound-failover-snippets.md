# Inbound application-server failover

The production `opensips.cfg` is intentionally excluded from Git. Apply the
following two changes to `/usr/local/etc/opensips/opensips.cfg` after deploying
the UI/API changes which manage failover servers and dispatcher priorities.

## 1. Select the primary application server first

In `route[DISPATCHER]`, replace the single `ds_select_domain(...,4,"f")`
block with the following. Incoming calls use algorithm 8, which selects the
first active destination in dispatcher priority order. Outgoing provider sets
retain their existing weighted round-robin behavior.

```opensips
# Application destinations are ordered primary -> failover by dispatcher
# priority. Provider sets retain weighted round-robin behavior.
if ($dlg_val(call_direction) == "INCOMING") {
        if (!ds_select_domain($(param(1){s.int}),8,"f")) {
                send_reply(500,"Unable to found destination gateway");
                exit;
        }
} else {
        if (!ds_select_domain($(param(1){s.int}),4,"f")) {
                send_reply(500,"Unable to found destination gateway");
                exit;
        }
}
```

## 2. Retry the next application server

Replace `failure_route[TRY_NEXT_INCOMING_TRUNK]` with:

```opensips
failure_route[TRY_NEXT_INCOMING_TRUNK]{
        if (t_was_cancelled()) {
                route(RTPENGINE_DELETE);
                exit;
        }

        # Retry only availability failures. Do not fail over business responses
        # such as 404 Not Found, 486 Busy Here, or 603 Decline.
        if (t_check_status("408|500|502|503|504")) {
                ds_mark_dst("p");
                if (ds_next_domain()) {
                        xlog("L_WARN","[TRY_NEXT_INCOMING_TRUNK]#$ci#$rm# Primary unavailable ($(<reply>rs)); retrying application destination $rd:$rp\n");
                        $acc_extra(dst_ip) = $rd;
                        t_on_failure("TRY_NEXT_INCOMING_TRUNK");
                        t_on_branch("INCOMING_BRANCH_ROUTE");
                        t_on_reply("DEFAULT_REPLY_ROUTE");
                        if (!t_relay()) {
                                xlog("L_ERR","[TRY_NEXT_INCOMING_TRUNK]#$ci#$rm# Failed to relay to failover application destination\n");
                                route(RTPENGINE_DELETE);
                        }
                        exit;
                }
        }

        route(RTPENGINE_DELETE);
        xlog("L_WARN","[TRY_NEXT_INCOMING_TRUNK]#$ci#$rm#$(<reply>rs) \n");
}
```

## Validate and activate

Do this with no active calls:

```bash
sudo cp -a /usr/local/etc/opensips/opensips.cfg \
  /usr/local/etc/opensips/opensips.cfg.before-app-failover

sudo /usr/local/sbin/opensips -C -f \
  /usr/local/etc/opensips/opensips.cfg

sudo systemctl restart opensips
sudo systemctl status opensips --no-pager
sudo opensips-cli -x mi ds_list
```

The UI stores the first server with dispatcher priority `0`; each added
failover server receives the next priority (`10`, `20`, and so on). Dispatcher
probing skips unavailable destinations on subsequent calls, while the failure
route retries the next destination for the current call.
