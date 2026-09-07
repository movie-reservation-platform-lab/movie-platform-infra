-- Keep the archive contract separate from ECS/Fluent Bit transport fields.
-- This deliberately small validator mirrors docs/contracts/platform-audit-event-v1.schema.json.
local function fields(value, allowed, required)
    if type(value) ~= "table" then return false end
    for key in pairs(value) do if not allowed[key] then return false end end
    for _, key in ipairs(required) do if value[key] == nil then return false end end
    return true
end

local function keys(list)
    local result = {}
    for _, key in ipairs(list) do result[key] = true end
    return result
end

local function text(value, maximum)
    return type(value) == "string" and #value > 0 and #value <= maximum
        and not value:find("[%z\1-\31\127]")
end

local function identifier(value)
    return text(value, 128) and not value:find("[^A-Za-z0-9._:/@-]")
end

local function hex(value, length)
    return type(value) == "string" and #value == length
        and not value:find("[^0-9a-f]") and value ~= string.rep("0", length)
end

local services = keys({"movie-reservation-service", "movie-reservation-agent", "movie-recommendation-service"})
local failures = keys({"INVALID_CREDENTIALS", "MISSING_CREDENTIALS", "MALFORMED_CREDENTIALS", "INVALID_TOKEN", "UNAUTHENTICATED"})
local event_fields = {"activity_id", "activity_name", "category_uid", "class_uid", "type_uid", "severity_id", "status_id", "status_detail", "time", "metadata", "service", "user", "unmapped"}
local platform_fields = {"schema_version", "environment", "request_id", "trace_id", "span_id", "aws_alb_trace_id", "aws_cloudfront_request_id", "route", "auth_boundary"}

local function valid_event(event, tag)
    if not fields(event, keys(event_fields), event_fields) then return false end
    if event.class_uid ~= 3002 or event.category_uid ~= 3 or event.type_uid ~= 300299
        or event.activity_id ~= 99 or event.activity_name ~= "Credential validation" then return false end
    if type(event.time) ~= "number" or event.time < 0 or event.time % 1 ~= 0 then return false end
    if not fields(event.service, keys({"name", "version"}), {"name", "version"})
        or not services[event.service.name] or not text(event.service.version, 128) then return false end
    -- A web/MCP log cannot impersonate a producer simply by writing an envelope.
    if tag:sub(1, #event.service.name + 10) ~= event.service.name .. "-firelens-" then return false end
    local metadata = event.metadata
    if not fields(metadata, keys({"uid", "version", "correlation_uid", "product"}), {"uid", "version", "correlation_uid", "product"})
        or metadata.version ~= "1.3.0" or not identifier(metadata.correlation_uid) then return false end
    if type(metadata.uid) ~= "string" or #metadata.uid ~= 36
        or metadata.uid:find("[A-F]")
        or not metadata.uid:match("^%x%x%x%x%x%x%x%x%-%x%x%x%x%-4%x%x%x%-[89ab]%x%x%x%-%x%x%x%x%x%x%x%x%x%x%x%x$") then return false end
    if not fields(metadata.product, keys({"name", "vendor_name", "version"}), {"name", "vendor_name", "version"})
        or metadata.product.name ~= event.service.name or metadata.product.version ~= event.service.version
        or metadata.product.vendor_name ~= "Movie Reservation Platform Lab" then return false end
    if not fields(event.user, keys({"name", "type_id"}), {"name", "type_id"}) then return false end
    if event.status_id == 2 then
        if event.severity_id ~= 2 or not failures[event.status_detail]
            or event.user.name ~= "unknown" or event.user.type_id ~= 0 then return false end
    elseif event.status_id == 1 then
        if event.severity_id ~= 1 or event.status_detail ~= "AUTHENTICATED"
            or event.user.name ~= "demo-user" or event.user.type_id ~= 1 then return false end
    else return false end
    if not fields(event.unmapped, keys({"platform"}), {"platform"}) then return false end
    local platform = event.unmapped.platform
    if not fields(platform, keys(platform_fields), {"schema_version", "environment", "request_id", "route", "auth_boundary"})
        or platform.schema_version ~= "1" or not text(platform.environment, 128)
        or not identifier(platform.request_id) or not text(platform.route, 256)
        or platform.route:sub(1, 1) ~= "/" or platform.route:find("?", 1, true)
        or not keys({"demo_login", "graphql", "api_auth"})[platform.auth_boundary] then return false end
    if platform.trace_id ~= nil and not hex(platform.trace_id, 32) then return false end
    if platform.span_id ~= nil and not hex(platform.span_id, 16) then return false end
    for _, name in ipairs({"aws_alb_trace_id", "aws_cloudfront_request_id"}) do
        if platform[name] ~= nil and (not text(platform[name], 512) or platform[name]:find("[^ -~]")) then return false end
    end
    return true
end

function route_record(tag, timestamp, record)
    local audit_shaped = record.audit ~= nil or
        (type(record.log) == "string" and record.log:find('"audit"%s*:') ~= nil)
    if not audit_shaped then
        -- Never let an ordinary JSON field forge our internal routing marker.
        record._audit_route = nil
        return 2, timestamp, record
    end
    local transport = keys({"audit", "log", "source", "container_id", "container_name"})
    if fields(record, transport, {"audit"}) and valid_event(record.audit, tag) then
        record.audit._audit_route = "audit"
        return 2, timestamp, record.audit
    end
    -- Never quarantine raw credentials. Producer schema tests preserve debugging
    -- evidence; this diagnostic tells operators that a deployment is misbehaving.
    return 2, timestamp, {
        _audit_route = "rejected",
        log = '{"event":"audit_router.rejected","reason":"invalid_audit_envelope"}'
    }
end
