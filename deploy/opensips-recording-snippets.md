# Per-trunk RTPengine recording integration

The production `opensips.cfg` is intentionally excluded from Git. Apply these
three changes to `/usr/local/etc/opensips/opensips.cfg` after adding
`sbc_trunks.recording_enabled` with migration 005.

## 1. Resolve recording for inbound calls

In `route[DID_MAPPING]`, after the inbound trunk enabled check and before any
cached DID route is dispatched, add:

```opensips
$dlg_val(recording_enabled) = "0";
$avp(inbound_recording_enabled) = NULL;
avp_db_query("SELECT COALESCE(t.recording_enabled,0) FROM did_provider_mapping p JOIN sbc_trunks t ON t.provider_dispatcher_set=p.sipline_set_id WHERE t.enabled=1 AND '$avp(standard_did_number)' BETWEEN p.start_did AND COALESCE(p.end_did, p.start_did) ORDER BY LENGTH(p.start_did) DESC, p.start_did DESC, t.id LIMIT 1", "$avp(inbound_recording_enabled)");
if ($avp(inbound_recording_enabled) == "1") {
        $dlg_val(recording_enabled) = "1";
        xlog("L_INFO","[DID_MAPPING]#$ci#$rm# Recording enabled for inbound DID $avp(standard_did_number)\n");
}
```

## 2. Resolve recording for outbound calls

In `route[DISPATCHER]`, initialize `$dlg_val(recording_enabled)` to `"0"` with
the outbound pilot and PAI dialog values. Extend the existing `sbc_trunks`
identity query to return `recording_enabled` as its third value:

```opensips
$dlg_val(recording_enabled) = "0";
$avp(selected_trunk_recording) = NULL;
avp_db_query("SELECT username,COALESCE(custom_pai_uri,''),COALESCE(recording_enabled,0) FROM sbc_trunks WHERE enabled=1 AND provider_dispatcher_set='$(param(1){s.int})' ORDER BY id LIMIT 1", "$avp(selected_trunk_cli);$avp(selected_trunk_pai);$avp(selected_trunk_recording)");

if ($avp(selected_trunk_recording) == "1") {
        $dlg_val(recording_enabled) = "1";
        xlog("L_INFO","[DISPATCHER]#$ci#$rm# Recording enabled for outbound trunk set $param(1)\n");
}
```

Keep the existing pilot CLI and PAI handling around this query.

## 3. Enable recording on the initial RTPengine offer

In `route[RTPENGINE_MANAGE]`, append the recording flag immediately after
building `$var(cmd)` and before calling `rtpengine_manage()`:

```opensips
if ($dlg_val(recording_enabled) == "1") {
        $var(cmd) = $var(cmd) + " record-call=yes";
}
```

Validate and restart OpenSIPS:

```bash
sudo /usr/local/sbin/opensips -C -f /usr/local/etc/opensips/opensips.cfg
sudo systemctl restart opensips
sudo systemctl status opensips --no-pager
```
