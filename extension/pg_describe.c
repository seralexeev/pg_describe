#include "postgres.h"

#include <ctype.h>

#include "access/genam.h"
#include "access/htup_details.h"
#include "access/stratnum.h"
#include "access/table.h"
#include "access/xact.h"
#include "access/transam.h"
#include "catalog/pg_am_d.h"
#include "catalog/pg_attribute.h"
#include "catalog/pg_constraint.h"
#include "catalog/pg_inherits.h"
#include "catalog/pg_language.h"
#include "catalog/pg_namespace_d.h"
#include "catalog/pg_operator_d.h"
#include "catalog/pg_proc.h"
#include "catalog/pg_trigger.h"
#include "catalog/pg_type.h"
#include "commands/trigger.h"
#include "executor/functions.h"
#include "fmgr.h"
#include "lib/stringinfo.h"
#include "nodes/bitmapset.h"
#include "nodes/makefuncs.h"
#include "nodes/nodeFuncs.h"
#include "optimizer/optimizer.h"
#include "parser/analyze.h"
#include "parser/parser.h"
#include "parser/parsetree.h"
#include "rewrite/rewriteManip.h"
#include "tcop/tcopprot.h"
#include "utils/array.h"
#include "utils/builtins.h"
#include "utils/json.h"
#include "utils/lsyscache.h"
#include "utils/rel.h"
#include "utils/syscache.h"

#if PG_VERSION_NUM < 180000
#error "pg_describe requires PostgreSQL 18 or later"
#endif

PG_MODULE_MAGIC;

typedef struct Scope
{
	Query	   *query;
	struct Scope *parent;
	List	   *quals;
	bool		quals_loaded;
} Scope;

typedef struct Params
{
	int			count;
	bool	   *nullable;
} Params;

static bool expr_nullable(Node *node, Scope *scope, Params *params);
static bool column_nullable(Query *query, int index, Scope *parent, Params *params);
static bool element_nullable(Node *node, Scope *scope, Params *params);
static bool function_preserves_nonnull(Oid funcid);

typedef enum RowBound
{
	ROWS_ONE,
	ROWS_MAYBE,
	ROWS_MANY,
} RowBound;

static RowBound query_row_bound(Query *query, Scope *parent);

static Scope *
scope_up(Scope *scope, Index levels)
{
	while (levels-- > 0)
		scope = scope->parent;
	return scope;
}

static bool
is_builtin(Oid funcid, const char *name)
{
	return get_func_namespace(funcid) == PG_CATALOG_NAMESPACE &&
		strcmp(get_func_name(funcid), name) == 0;
}

static CommonTableExpr *
find_cte(Scope *scope, RangeTblEntry *rte, Scope **cte_scope)
{
	ListCell   *lc;

	*cte_scope = scope_up(scope, rte->ctelevelsup);
	foreach(lc, (*cte_scope)->query->cteList)
	{
		CommonTableExpr *cte = lfirst(lc);

		if (strcmp(cte->ctename, rte->ctename) == 0)
			return cte;
	}
	return NULL;
}

static Node *
strip_casts(Node *node)
{
	for (;;)
	{
		if (node == NULL)
			return NULL;
		if (IsA(node, RelabelType))
			node = (Node *) ((RelabelType *) node)->arg;
		else if (IsA(node, CoerceViaIO))
			node = (Node *) ((CoerceViaIO *) node)->arg;
		else if (IsA(node, ArrayCoerceExpr))
			node = (Node *) ((ArrayCoerceExpr *) node)->arg;
		else if (IsA(node, NamedArgExpr))
			node = (Node *) ((NamedArgExpr *) node)->arg;
		else if (IsA(node, ConvertRowtypeExpr))
			node = (Node *) ((ConvertRowtypeExpr *) node)->arg;
		else if (IsA(node, CollateExpr))
			node = (Node *) ((CollateExpr *) node)->arg;
		else if (IsA(node, CoerceToDomain))
			node = (Node *) ((CoerceToDomain *) node)->arg;
		else if (IsA(node, FuncExpr) &&
				 (((FuncExpr *) node)->funcformat == COERCE_EXPLICIT_CAST ||
				  ((FuncExpr *) node)->funcformat == COERCE_IMPLICIT_CAST) &&
				 list_length(((FuncExpr *) node)->args) >= 1 &&
				 function_preserves_nonnull(((FuncExpr *) node)->funcid))
			node = linitial(((FuncExpr *) node)->args);
		else
			return node;
	}
}

/*
 * Strict internal functions, by C symbol, that still return NULL for some
 * non-null inputs: lookups that can miss, bounds of empty arrays and ranges,
 * failed matches. System information functions (pg_*, has_*) answer NULL for
 * objects that do not exist.
 */
static const char *const null_returning_functions[] = {
	"extract_date", "extract_interval", "extract_time", "extract_timestamp",
	"extract_timestamptz", "extract_timetz", "float4_to_char", "float8_to_char",
	"int4_to_char", "int8_to_char", "interval_to_char", "jsonb_path_exists",
	"jsonb_path_exists_opr", "jsonb_path_exists_tz", "jsonb_path_match",
	"jsonb_path_match_opr", "jsonb_path_match_tz", "numeric_scale", "numeric_to_char",
	"timestamp_to_char", "timestamptz_to_char",
	"array_dims", "array_length", "array_lower", "array_ndims", "array_position",
	"array_upper", "current_schema", "inet_client_addr", "inet_client_port",
	"inet_server_addr", "inet_server_port", "json_array_element",
	"json_array_element_text", "json_extract_path", "json_extract_path_text",
	"json_object_field", "json_object_field_text", "jsonb_array_element",
	"jsonb_array_element_text", "jsonb_extract_path", "jsonb_extract_path_text",
	"jsonb_object_field", "jsonb_object_field_text", "jsonb_path_query_first",
	"jsonb_path_query_first_tz", "multirange_lower", "multirange_upper",
	"range_lower", "range_upper", "regexp_match", "regexp_match_no_flags",
	"regexp_substr", "regexp_substr_no_n", "regexp_substr_no_start",
	"regexp_substr_no_flags", "regexp_substr_no_subexpr", "show_config_by_name_missing_ok",
	"textregexsubstr", "to_regclass", "to_regcollation", "to_regnamespace",
	"to_regoper", "to_regoperator", "to_regproc", "to_regprocedure", "to_regrole",
	"to_regtype", "to_regtypemod", "uuid_extract_timestamp", "uuid_extract_version",
};

static bool
function_preserves_nonnull(Oid funcid)
{
	HeapTuple	tuple;
	Form_pg_proc proc;
	char	   *symbol;
	bool		preserves;

	if (funcid >= FirstNormalObjectId)
		return false;

	tuple = SearchSysCache1(PROCOID, ObjectIdGetDatum(funcid));
	if (!HeapTupleIsValid(tuple))
		return false;
	proc = (Form_pg_proc) GETSTRUCT(tuple);
	symbol = TextDatumGetCString(SysCacheGetAttrNotNull(PROCOID, tuple, Anum_pg_proc_prosrc));
	preserves = proc->proisstrict && !proc->proretset && proc->prolang == INTERNALlanguageId &&
		strncmp(symbol, "pg_", 3) != 0 && strncmp(symbol, "has_", 4) != 0;
	for (int i = 0; preserves && i < lengthof(null_returning_functions); i++)
		preserves = strcmp(symbol, null_returning_functions[i]) != 0;
	ReleaseSysCache(tuple);
	return preserves;
}

/* A call's arguments in declaration order, named ones placed and omitted ones taken from their defaults. */
static List *
call_arguments(FuncExpr *fn)
{
	HeapTuple	tuple = SearchSysCache1(PROCOID, ObjectIdGetDatum(fn->funcid));
	Form_pg_proc proc;
	Node	  **slots;
	List	   *defaults = NIL;
	List	   *result = NIL;
	Datum		datum;
	bool		isnull;
	int			position = 0;
	ListCell   *lc;

	if (!HeapTupleIsValid(tuple))
		return fn->args;
	proc = (Form_pg_proc) GETSTRUCT(tuple);
	slots = palloc0(sizeof(Node *) * (Max(proc->pronargs, list_length(fn->args)) + 1));

	foreach(lc, fn->args)
	{
		Node	   *arg = lfirst(lc);

		if (IsA(arg, NamedArgExpr))
			slots[((NamedArgExpr *) arg)->argnumber] = (Node *) ((NamedArgExpr *) arg)->arg;
		else
			slots[position] = arg;
		position++;
	}

	datum = SysCacheGetAttr(PROCOID, tuple, Anum_pg_proc_proargdefaults, &isnull);
	if (!isnull)
		defaults = castNode(List, stringToNode(TextDatumGetCString(datum)));

	for (int i = 0; i < proc->pronargs; i++)
	{
		int			default_index = i - (proc->pronargs - list_length(defaults));

		if (slots[i] == NULL && default_index >= 0)
			slots[i] = list_nth(defaults, default_index);
		result = lappend(result, slots[i]);
	}
	ReleaseSysCache(tuple);
	return result;
}

/* A body that no longer parses makes the function opaque instead of failing the whole describe. */
static Query *
analyze_function_source(HeapTuple tuple, FuncExpr *fn)
{
	char	   *src = TextDatumGetCString(SysCacheGetAttrNotNull(PROCOID, tuple, Anum_pg_proc_prosrc));
	MemoryContext outer = CurrentMemoryContext;
	ResourceOwner owner = CurrentResourceOwner;
	Query	   *body = NULL;

	BeginInternalSubTransaction(NULL);
	PG_TRY();
	{
		List	   *raw = raw_parser(src, RAW_PARSE_DEFAULT);
		SQLFunctionParseInfoPtr info = prepare_sql_fn_parse_info(tuple, (Node *) fn, fn->inputcollid);

		if (raw != NIL)
			body = parse_analyze_withcb(llast_node(RawStmt, raw), src,
										(ParserSetupHook) sql_fn_parser_setup, info, NULL);
		ReleaseCurrentSubTransaction();
	}
	PG_CATCH();
	{
		MemoryContextSwitchTo(outer);
		FlushErrorState();
		RollbackAndReleaseCurrentSubTransaction();
		body = NULL;
	}
	PG_END_TRY();
	MemoryContextSwitchTo(outer);
	CurrentResourceOwner = owner;
	return body;
}

/* The single row-returning SELECT a SQL-language function evaluates, when it is that simple. */
static Query *
sql_function_body(FuncExpr *fn)
{
	HeapTuple	tuple = SearchSysCache1(PROCOID, ObjectIdGetDatum(fn->funcid));
	Form_pg_proc proc;
	Query	   *body = NULL;
	Datum		datum;
	bool		isnull;

	if (!HeapTupleIsValid(tuple))
		return NULL;
	proc = (Form_pg_proc) GETSTRUCT(tuple);

	(void) SysCacheGetAttr(PROCOID, tuple, Anum_pg_proc_proconfig, &isnull);
	if (proc->prolang == SQLlanguageId && !proc->proretset && isnull)
	{
		datum = SysCacheGetAttr(PROCOID, tuple, Anum_pg_proc_prosqlbody, &isnull);
		if (!isnull)
		{
			Node	   *n = stringToNode(TextDatumGetCString(datum));

			while (n != NULL && IsA(n, List))
				n = list_length((List *) n) > 0 ? llast((List *) n) : NULL;
			body = n != NULL ? castNode(Query, n) : NULL;
		}
		else
		{
			body = analyze_function_source(tuple, fn);
		}
	}
	ReleaseSysCache(tuple);

	return body != NULL && body->commandType == CMD_SELECT &&
		query_row_bound(body, NULL) == ROWS_ONE ? body : NULL;
}

static bool
sql_function_nullable(FuncExpr *fn, Query *body, Scope *scope, Params *params)
{
	static int	depth = 0;
	List	   *args = call_arguments(fn);
	Params		inner = {list_length(args), palloc0(sizeof(bool) * Max(list_length(args), 1))};
	bool		nullable;

	if (depth >= 16)
		return true;

	for (int i = 0; i < inner.count; i++)
		inner.nullable[i] = expr_nullable(list_nth(args, i), scope, params);

	if (func_strict(fn->funcid))
	{
		for (int i = 0; i < inner.count; i++)
		{
			if (inner.nullable[i])
				return true;
		}
	}

	depth++;
	PG_TRY();
	{
		nullable = column_nullable(body, 0, NULL, &inner);
	}
	PG_FINALLY();
	{
		depth--;
	}
	PG_END_TRY();
	return nullable;
}

/* Any coercion at all, for finding the parameter an assignment or a null test is about. */
static Node *
strip_coercions(Node *node)
{
	for (;;)
	{
		Node	   *stripped = strip_casts(node);

		if (stripped != NULL && IsA(stripped, FuncExpr) &&
			((FuncExpr *) stripped)->funcformat != COERCE_EXPLICIT_CALL &&
			list_length(((FuncExpr *) stripped)->args) >= 1)
			node = linitial(((FuncExpr *) stripped)->args);
		else
			return stripped;
	}
}

static bool
any_nullable(List *args, Scope *scope, Params *params)
{
	ListCell   *lc;

	foreach(lc, args)
	{
		if (expr_nullable(lfirst(lc), scope, params))
			return true;
	}
	return false;
}

static bool
all_nullable(List *args, Scope *scope, Params *params)
{
	ListCell   *lc;

	foreach(lc, args)
	{
		if (!expr_nullable(lfirst(lc), scope, params))
			return false;
	}
	return true;
}

/* attnotnull alone also covers constraints still being validated and ones children do not inherit. */
static bool
attribute_nullable(Oid relid, AttrNumber attno, bool inherited)
{
	HeapTuple	tuple;
	bool		nullable;

	if (attno <= 0)
		return false;

	tuple = SearchSysCache2(ATTNUM, ObjectIdGetDatum(relid), Int16GetDatum(attno));
	if (!HeapTupleIsValid(tuple))
		return true;
	nullable = !((Form_pg_attribute) GETSTRUCT(tuple))->attnotnull;
	ReleaseSysCache(tuple);
	if (nullable)
		return true;

	tuple = findNotNullConstraintAttnum(relid, attno);
	if (HeapTupleIsValid(tuple))
	{
		Form_pg_constraint con = (Form_pg_constraint) GETSTRUCT(tuple);

		nullable = !con->convalidated || (con->connoinherit && inherited);
		heap_freetuple(tuple);
	}
	return nullable;
}

static bool
setop_nullable(Node *node, Query *query, int index, Scope *scope, Params *params)
{
	if (IsA(node, RangeTblRef))
	{
		RangeTblEntry *rte = rt_fetch(((RangeTblRef *) node)->rtindex, query->rtable);

		return column_nullable(rte->subquery, index, scope, params);
	}
	else
	{
		SetOperationStmt *op = (SetOperationStmt *) node;

		return setop_nullable(op->larg, query, index, scope, params) ||
			setop_nullable(op->rarg, query, index, scope, params);
	}
}

static List *
output_list(Query *query)
{
	return query->commandType == CMD_SELECT ? query->targetList : query->returningList;
}

static bool
column_nullable(Query *query, int index, Scope *parent, Params *params)
{
	Scope		scope = {query, parent, NIL, false};
	int			position = 0;
	ListCell   *lc;

	if (query->commandType == CMD_MERGE)
		return true;
	if (query->setOperations != NULL)
		return setop_nullable(query->setOperations, query, index, &scope, params);

	foreach(lc, output_list(query))
	{
		TargetEntry *te = lfirst(lc);

		if (te->resjunk)
			continue;
		if (position++ == index)
			return expr_nullable((Node *) te->expr, &scope, params);
	}
	return true;
}

static List *
is_not_null(Node *node)
{
	NullTest   *test = makeNode(NullTest);

	test->arg = (Expr *) node;
	test->nulltesttype = IS_NOT_NULL;
	test->location = -1;
	return list_make1(test);
}

/* WHERE and inner-join quals hold for every row a query returns; outer-join quals do not. */
static List *
row_quals(Node *node)
{
	ListCell   *lc;

	if (node == NULL)
		return NIL;

	if (IsA(node, FromExpr))
	{
		FromExpr   *from = (FromExpr *) node;
		List	   *quals = make_ands_implicit((Expr *) from->quals);

		foreach(lc, from->fromlist)
			quals = list_concat(quals, row_quals(lfirst(lc)));
		return quals;
	}

	if (IsA(node, JoinExpr))
	{
		JoinExpr   *join = (JoinExpr *) node;
		List	   *quals = join->jointype == JOIN_INNER
			? make_ands_implicit((Expr *) join->quals) : NIL;

		quals = list_concat(quals, row_quals(join->larg));
		return list_concat(quals, row_quals(join->rarg));
	}

	return NIL;
}

/* The columns a plpgsql BEFORE UPDATE trigger body touches through NEW; any other language touches them all. */
static Bitmapset *
trigger_assigned_columns(Relation rel, Bitmapset *assigned)
{
	TriggerDesc *triggers = rel->trigdesc;

	for (int i = 0; triggers != NULL && i < triggers->numtriggers; i++)
	{
		Trigger    *trigger = &triggers->triggers[i];
		HeapTuple	tuple;
		Form_pg_proc proc;
		char	   *source;
		char	   *at;

		if (trigger->tgenabled == TRIGGER_DISABLED || !TRIGGER_FOR_ROW(trigger->tgtype) ||
			!TRIGGER_FOR_BEFORE(trigger->tgtype) || !TRIGGER_FOR_UPDATE(trigger->tgtype))
			continue;
		tuple = SearchSysCache1(PROCOID, ObjectIdGetDatum(trigger->tgfoid));
		if (!HeapTupleIsValid(tuple))
			return bms_add_range(assigned, 0, RelationGetDescr(rel)->natts - FirstLowInvalidHeapAttributeNumber);
		proc = (Form_pg_proc) GETSTRUCT(tuple);
		if (strcmp(get_language_name(proc->prolang, false), "plpgsql") != 0)
		{
			ReleaseSysCache(tuple);
			return bms_add_range(assigned, 0, RelationGetDescr(rel)->natts - FirstLowInvalidHeapAttributeNumber);
		}
		source = TextDatumGetCString(SysCacheGetAttrNotNull(PROCOID, tuple, Anum_pg_proc_prosrc));
		ReleaseSysCache(tuple);

		for (at = source; (at = strcasestr(at, "new")) != NULL; at += 3)
		{
			char	   *name;
			int			length = 0;

			if (at > source && (isalnum((unsigned char) at[-1]) || at[-1] == '_'))
				continue;
			if (at[3] != '.')
			{
				char	   *next = at + 3;

				while (isspace((unsigned char) *next))
					next++;
				if (!isalnum((unsigned char) at[3]) && at[3] != '_' &&
					(strncmp(next, ":=", 2) == 0 || (*next == '=' && next[1] != '=')))
					return bms_add_range(assigned, 0, RelationGetDescr(rel)->natts - FirstLowInvalidHeapAttributeNumber);
				continue;
			}
			name = at + 4;
			while (isalnum((unsigned char) name[length]) || name[length] == '_')
				length++;
			assigned = bms_add_member(assigned,
									  get_attnum(RelationGetRelid(rel), pnstrdup(name, length)) -
									  FirstLowInvalidHeapAttributeNumber);
		}
	}
	return assigned;
}

/* A plpgsql trigger body whose every RETURN hands back NEW keeps the row; anything else may drop it. */
static bool
trigger_may_return_null(Oid funcid)
{
	HeapTuple	tuple = SearchSysCache1(PROCOID, ObjectIdGetDatum(funcid));
	Form_pg_proc proc;
	char	   *source;
	char	   *at;
	bool		returns_new = false;
	bool		may = false;

	if (!HeapTupleIsValid(tuple))
		return true;
	proc = (Form_pg_proc) GETSTRUCT(tuple);
	if (strcmp(get_language_name(proc->prolang, false), "plpgsql") != 0)
	{
		ReleaseSysCache(tuple);
		return true;
	}
	source = TextDatumGetCString(SysCacheGetAttrNotNull(PROCOID, tuple, Anum_pg_proc_prosrc));
	ReleaseSysCache(tuple);

	for (at = source; (at = strcasestr(at, "return")) != NULL; at += 6)
	{
		char	   *value;

		if (at > source && (isalnum((unsigned char) at[-1]) || at[-1] == '_'))
			continue;
		if (isalnum((unsigned char) at[6]) || at[6] == '_')
			continue;
		value = at + 6;
		while (isspace((unsigned char) *value))
			value++;
		if (pg_strncasecmp(value, "new", 3) == 0 && !isalnum((unsigned char) value[3]) && value[3] != '_')
			returns_new = true;
		else
			may = true;
	}
	return may || !returns_new;
}

/* An UPDATE's quals describe the old row, so only those on columns it keeps hold for what it returns. */
static List *
returned_row_quals(Query *query)
{
	List	   *quals = row_quals((Node *) query->jointree);
	Bitmapset  *assigned = NULL;
	List	   *kept = NIL;
	Relation	rel;
	ListCell   *lc;

	if (query->commandType != CMD_UPDATE)
		return quals;

	rel = table_open(rt_fetch(query->resultRelation, query->rtable)->relid, AccessShareLock);
	assigned = trigger_assigned_columns(rel, assigned);
	for (int i = 0; i < RelationGetDescr(rel)->natts; i++)
	{
		if (TupleDescAttr(RelationGetDescr(rel), i)->attgenerated != '\0')
			assigned = bms_add_member(assigned, i + 1 - FirstLowInvalidHeapAttributeNumber);
	}
	table_close(rel, AccessShareLock);

	foreach(lc, query->targetList)
	{
		TargetEntry *te = lfirst(lc);

		if (!te->resjunk)
			assigned = bms_add_member(assigned, te->resno - FirstLowInvalidHeapAttributeNumber);
	}

	foreach(lc, quals)
	{
		Bitmapset  *used = NULL;

		pull_varattnos(lfirst(lc), query->resultRelation, &used);
		if (!bms_overlap(used, assigned))
			kept = lappend(kept, lfirst(lc));
	}
	return kept;
}

static List *
scope_quals(Scope *scope)
{
	if (!scope->quals_loaded)
	{
		scope->quals = returned_row_quals(scope->query);
		scope->quals_loaded = true;
	}
	return scope->quals;
}

/*
 * A CHECK constraint is only known not to be false. Arms of its OR that the
 * row's quals refute drop out; whatever remains must still not be false.
 */
static bool
checks_imply_not_null(Oid relid, bool inherited, Var *var, List *quals)
{
	Relation	rel = table_open(relid, AccessShareLock);
	TupleConstr *constr = RelationGetDescr(rel)->constr;
	List	   *goal = is_not_null((Node *) var);
	bool		proven = false;

	for (int i = 0; constr != NULL && i < constr->num_check && !proven; i++)
	{
		Node	   *check;
		ListCell   *lc;

		if (!constr->check[i].ccvalid || (constr->check[i].ccnoinherit && inherited))
			continue;

		check = stringToNode(constr->check[i].ccbin);
		ChangeVarNodes(check, 1, var->varno, 0);

		foreach(lc, make_ands_implicit((Expr *) check))
		{
			Node	   *conjunct = lfirst(lc);
			List	   *arms = is_orclause(conjunct) ? ((BoolExpr *) conjunct)->args : list_make1(conjunct);
			List	   *remaining = NIL;
			ListCell   *arm;

			foreach(arm, arms)
			{
				if (!predicate_refuted_by(list_make1(lfirst(arm)), quals, false))
					remaining = lappend(remaining, lfirst(arm));
			}

			if (remaining == NIL ||
				predicate_implied_by(goal,
									 list_make1(list_length(remaining) == 1
												? linitial(remaining)
												: make_orclause(remaining)),
									 true))
			{
				proven = true;
				break;
			}
		}
	}

	table_close(rel, AccessShareLock);
	return proven;
}

static bool
returning_row_missing(VarReturningType type, CmdType command)
{
	switch (type)
	{
		case VAR_RETURNING_OLD:
			return command != CMD_UPDATE && command != CMD_DELETE;
		case VAR_RETURNING_NEW:
			return command != CMD_UPDATE && command != CMD_INSERT;
		default:
			return false;
	}
}

static bool
var_nullable(Var *var, Scope *scope, Params *params)
{
	Scope	   *owner;
	RangeTblEntry *rte;
	List	   *quals = NIL;
	int			index = var->varattno - 1;

	owner = scope_up(scope, var->varlevelsup);

	if (var->varreturningtype == VAR_RETURNING_DEFAULT)
	{
		Var		   *local = copyObject(var);

		local->varlevelsup = 0;
		quals = scope_quals(owner);
		if (predicate_implied_by(is_not_null((Node *) local), quals, false))
			return false;
	}

	if (!bms_is_empty(var->varnullingrels) ||
		returning_row_missing(var->varreturningtype, owner->query->commandType))
		return true;

	rte = rt_fetch(var->varno, owner->query->rtable);

	if (var->varattno == InvalidAttrNumber)
		return false;

	switch (rte->rtekind)
	{
		case RTE_RELATION:
				return attribute_nullable(rte->relid, var->varattno, rte->inh) &&
				!(var->varreturningtype == VAR_RETURNING_DEFAULT &&
				  checks_imply_not_null(rte->relid, rte->inh, var, quals));
		case RTE_SUBQUERY:
			return column_nullable(rte->subquery, index, owner, params);
		case RTE_JOIN:
			if (index < list_length(rte->joinaliasvars))
				return expr_nullable(list_nth(rte->joinaliasvars, index), owner, params);
			return true;
		case RTE_GROUP:
			return expr_nullable(list_nth(rte->groupexprs, index), owner, params);
		case RTE_VALUES:
			{
				ListCell   *lc;

				foreach(lc, rte->values_lists)
				{
					if (expr_nullable(list_nth(lfirst(lc), index), owner, params))
						return true;
				}
				return false;
			}
		case RTE_FUNCTION:
			{
				RangeTblFunction *fn = list_length(rte->functions) == 1 ? linitial(rte->functions) : NULL;
				FuncExpr   *call = fn != NULL && IsA(fn->funcexpr, FuncExpr) ? (FuncExpr *) fn->funcexpr : NULL;

				if (call != NULL && list_length(call->args) == 1 && !rte->funcordinality &&
					is_builtin(call->funcid, "unnest") &&
					type_is_array(exprType(linitial(call->args))))
					return element_nullable(linitial(call->args), owner, params);
				return true;
			}
		case RTE_CTE:
			{
				Scope	   *cte_scope;
				CommonTableExpr *cte = rte->self_reference ? NULL : find_cte(owner, rte, &cte_scope);

				return cte == NULL || cte->cterecursive ||
					column_nullable((Query *) cte->ctequery, index, cte_scope, params);
			}
		default:
			return true;
	}
}

/* Built-in aggregates that return a value for every non-empty group of non-null input. */
static const char *const total_aggregates[] = {
	"array_agg", "avg", "bit_and", "bit_or", "bool_and", "bool_or", "every",
	"json_agg", "json_object_agg", "jsonb_agg", "jsonb_object_agg", "max", "min",
	"string_agg", "sum",
};

static bool
aggregate_nullable(Aggref *agg, Scope *scope, Params *params)
{
	Query	   *query = scope->query;
	bool		total = false;
	ListCell   *lc;

	if (is_builtin(agg->aggfnoid, "count"))
		return false;

	if (agg->agglevelsup != 0 || agg->aggfilter != NULL ||
		query->groupClause == NIL || query->groupingSets != NIL)
		return true;

	for (int i = 0; !total && i < lengthof(total_aggregates); i++)
		total = is_builtin(agg->aggfnoid, total_aggregates[i]);
	if (!total)
		return true;
	if (is_builtin(agg->aggfnoid, "array_agg") || is_builtin(agg->aggfnoid, "json_agg") ||
		is_builtin(agg->aggfnoid, "jsonb_agg"))
		return false;

	foreach(lc, agg->args)
	{
		if (expr_nullable((Node *) ((TargetEntry *) lfirst(lc))->expr, scope, params))
			return true;
	}
	return false;
}

static bool
window_nullable(WindowFunc *fn)
{
	static const char *const nonnull[] = {
		"count", "cume_dist", "dense_rank", "percent_rank", "rank", "row_number",
	};

	for (int i = 0; i < lengthof(nonnull); i++)
	{
		if (is_builtin(fn->winfnoid, nonnull[i]))
			return false;
	}
	return true;
}

static bool
sublink_nullable(SubLink *link, Scope *scope, Params *params)
{
	Query	   *sub = (Query *) link->subselect;

	switch (link->subLinkType)
	{
		case EXISTS_SUBLINK:
		case ARRAY_SUBLINK:
			return false;
		case EXPR_SUBLINK:
			return query_row_bound(sub, scope) != ROWS_ONE ||
				column_nullable(sub, 0, scope, params);
		default:
			return true;
	}
}

static bool
shape_nullable(Node *node, Scope *scope, Params *params)
{
	switch (nodeTag(node))
	{
		case T_Var:
			return var_nullable((Var *) node, scope, params);
		case T_Const:
			return ((Const *) node)->constisnull;
		case T_Param:
			{
				Param	   *param = (Param *) node;

				return param->paramkind != PARAM_EXTERN || param->paramid > params->count ||
					params->nullable[param->paramid - 1];
			}
		case T_NamedArgExpr:
		case T_RelabelType:
		case T_CoerceViaIO:
		case T_ArrayCoerceExpr:
		case T_CollateExpr:
		case T_ConvertRowtypeExpr:
		case T_CoerceToDomain:
			return expr_nullable(strip_casts(node), scope, params);
		case T_FuncExpr:
			{
				FuncExpr   *fn = (FuncExpr *) node;
				Query	   *body = sql_function_body(fn);

				if (body != NULL)
					return sql_function_nullable(fn, body, scope, params);
				return !function_preserves_nonnull(fn->funcid) ||
					any_nullable(call_arguments(fn), scope, params);
			}
		case T_OpExpr:
		case T_DistinctExpr:
			{
				OpExpr	   *op = (OpExpr *) node;

				if (IsA(node, DistinctExpr))
					return false;
				set_opfuncid(op);
				return !function_preserves_nonnull(op->opfuncid) ||
					any_nullable(op->args, scope, params);
			}
		case T_BoolExpr:
			return any_nullable(((BoolExpr *) node)->args, scope, params);
		case T_CaseExpr:
			{
				CaseExpr   *c = (CaseExpr *) node;
				ListCell   *lc;

				foreach(lc, c->args)
				{
					if (expr_nullable((Node *) ((CaseWhen *) lfirst(lc))->result, scope, params))
						return true;
				}
				return expr_nullable((Node *) c->defresult, scope, params);
			}
		case T_CoalesceExpr:
			return all_nullable(((CoalesceExpr *) node)->args, scope, params);
		case T_MinMaxExpr:
			return all_nullable(((MinMaxExpr *) node)->args, scope, params);
		case T_Aggref:
			return aggregate_nullable((Aggref *) node, scope, params);
		case T_WindowFunc:
			return window_nullable((WindowFunc *) node);
		case T_SubLink:
			return sublink_nullable((SubLink *) node, scope, params);
		case T_SQLValueFunction:
			return ((SQLValueFunction *) node)->op == SVFOP_CURRENT_SCHEMA;
		case T_NullTest:
		case T_BooleanTest:
		case T_ArrayExpr:
		case T_RowExpr:
		case T_GroupingFunc:
			return false;
		default:
			return true;
	}
}

/* Beyond its shape, an expression is non-null wherever the query's quals reject its NULL. */
static bool
expr_nullable(Node *node, Scope *scope, Params *params)
{
	if (node == NULL)
		return true;

	return shape_nullable(node, scope, params) &&
		(IsA(node, Var) ||
		 !predicate_implied_by(is_not_null(node), scope_quals(scope), false));
}

static void
mark_param_nullable(Node *node, Params *params)
{
	node = strip_coercions(node);
	if (node != NULL && IsA(node, Param))
	{
		Param	   *param = (Param *) node;

		if (param->paramkind == PARAM_EXTERN && param->paramid <= params->count)
			params->nullable[param->paramid - 1] = true;
	}
}

static void
mark_column_source(Query *query, Node *node, Params *params)
{
	node = strip_coercions(node);
	if (node == NULL)
		return;

	if (IsA(node, Var) && ((Var *) node)->varlevelsup == 0)
	{
		Var		   *var = (Var *) node;
		RangeTblEntry *rte = rt_fetch(var->varno, query->rtable);
		ListCell   *lc;

		if (rte->rtekind == RTE_VALUES)
		{
			foreach(lc, rte->values_lists)
				mark_param_nullable(list_nth(lfirst(lc), var->varattno - 1), params);
		}
		else if (rte->rtekind == RTE_SUBQUERY)
		{
			TargetEntry *te = list_nth(rte->subquery->targetList, var->varattno - 1);

			mark_column_source(rte->subquery, (Node *) te->expr, params);
		}
	}
	else
		mark_param_nullable(node, params);
}

static void
mark_assignments(Query *query, List *assignments, Params *params)
{
	RangeTblEntry *target = rt_fetch(query->resultRelation, query->rtable);
	ListCell   *lc;

	foreach(lc, assignments)
	{
		TargetEntry *te = lfirst(lc);

		if (!te->resjunk && attribute_nullable(target->relid, te->resno, false))
			mark_column_source(query, (Node *) te->expr, params);
	}
}

static bool
param_walker(Node *node, Params *params)
{
	ListCell   *lc;

	if (node == NULL)
		return false;

	if (IsA(node, Query))
	{
		Query	   *query = (Query *) node;

		if (query->commandType == CMD_INSERT || query->commandType == CMD_UPDATE)
			mark_assignments(query, query->targetList, params);
		if (query->onConflict != NULL)
			mark_assignments(query, query->onConflict->onConflictSet, params);
		return query_tree_walker(query, param_walker, params, 0);
	}

	switch (nodeTag(node))
	{
		case T_CoalesceExpr:
			foreach(lc, ((CoalesceExpr *) node)->args)
				mark_param_nullable(lfirst(lc), params);
			break;
		case T_MinMaxExpr:
			foreach(lc, ((MinMaxExpr *) node)->args)
				mark_param_nullable(lfirst(lc), params);
			break;
		case T_NullTest:
			mark_param_nullable((Node *) ((NullTest *) node)->arg, params);
			break;
		case T_BooleanTest:
			mark_param_nullable((Node *) ((BooleanTest *) node)->arg, params);
			break;
		case T_DistinctExpr:
		case T_NullIfExpr:
			foreach(lc, ((OpExpr *) node)->args)
				mark_param_nullable(lfirst(lc), params);
			break;
		case T_FuncExpr:
			{
				FuncExpr   *fn = (FuncExpr *) node;

				if (fn->funcformat == COERCE_EXPLICIT_CALL && !func_strict(fn->funcid))
				{
					foreach(lc, fn->args)
						mark_param_nullable(lfirst(lc), params);
				}
				break;
			}
		default:
			break;
	}

	return expression_tree_walker(node, param_walker, params);
}

static Query *
analyze(const char *sql, Oid **param_types, int *param_count)
{
	List	   *raw = raw_parser(sql, RAW_PARSE_DEFAULT);
	List	   *queries;
	ListCell   *lc;

	if (list_length(raw) != 1)
		ereport(ERROR,
				(errcode(ERRCODE_SYNTAX_ERROR),
				 errmsg("pg_describe expects exactly one statement")));

	queries = pg_analyze_and_rewrite_varparams(linitial_node(RawStmt, raw), sql,
											   param_types, param_count, NULL);
	foreach(lc, queries)
	{
		Query	   *query = lfirst(lc);

		if (query->canSetTag)
			return query;
	}
	ereport(ERROR,
			(errcode(ERRCODE_FEATURE_NOT_SUPPORTED),
			 errmsg("the statement rewrites to nothing")));
}

static bool
unbound_walker(Node *node, Bitmapset *bound)
{
	if (node == NULL)
		return false;
	if (IsA(node, Var))
	{
		Var		   *var = (Var *) node;

		return var->varlevelsup == 0 && !bms_is_member(var->varno, bound);
	}
	if (IsA(node, SubLink) || IsA(node, Aggref) || IsA(node, WindowFunc))
		return true;
	return expression_tree_walker(node, unbound_walker, bound);
}

/* A value that is the same for every row of the from clause. */
static bool
is_bound(Node *node, Bitmapset *bound)
{
	return !unbound_walker(node, bound) && !contain_volatile_functions(node);
}

typedef struct IndexKey
{
	Index		varno;
	AttrNumber	attno;
	Oid			opfamily;
	Oid			collation;
} IndexKey;

/* Types whose text form is unique per value regardless of session settings. */
static bool
text_form_is_injective(Oid type)
{
	switch (type)
	{
		case BOOLOID:
		case INT2OID:
		case INT4OID:
		case INT8OID:
		case OIDOID:
		case UUIDOID:
			return true;
		default:
			return false;
	}
}

/*
 * Whether the compared expression is the key column, plain or printed as
 * text. A plain comparison must use the index's own equality under its
 * collation; a text comparison must use text's, under a deterministic one.
 */
static bool
key_side(Node *node, IndexKey *key, OpExpr *op)
{
	bool		as_text = false;

	for (;;)
	{
		if (node != NULL && IsA(node, RelabelType))
			node = (Node *) ((RelabelType *) node)->arg;
		else if (node != NULL && IsA(node, CoerceViaIO) &&
				 (((CoerceViaIO *) node)->resulttype == TEXTOID ||
				  ((CoerceViaIO *) node)->resulttype == VARCHAROID) &&
				 text_form_is_injective(exprType((Node *) ((CoerceViaIO *) node)->arg)))
		{
			node = (Node *) ((CoerceViaIO *) node)->arg;
			as_text = true;
		}
		else
			break;
	}
	if (node == NULL || !IsA(node, Var) || ((Var *) node)->varlevelsup != 0 ||
		((Var *) node)->varno != key->varno || ((Var *) node)->varattno != key->attno)
		return false;

	if (as_text)
		return op->opno == TextEqualOperator &&
			(!OidIsValid(op->inputcollid) || get_collation_isdeterministic(op->inputcollid));
	return get_op_opfamily_strategy(op->opno, key->opfamily) == BTEqualStrategyNumber &&
		(!OidIsValid(key->collation) || op->inputcollid == key->collation ||
		 get_collation_isdeterministic(op->inputcollid));
}

typedef struct ScopedQual
{
	Node	   *qual;
	Bitmapset  *rels;
} ScopedQual;

/* The quals that hold for every surviving row of the relation: a WHERE or inner join condition over it, or the ON condition of an outer join it is the inner side of. */
static List *
quals_for(List *scoped, Index varno)
{
	List	   *quals = NIL;
	ListCell   *lc;

	foreach(lc, scoped)
	{
		ScopedQual *sq = lfirst(lc);

		if (bms_is_member(varno, sq->rels))
			quals = lappend(quals, sq->qual);
	}
	return quals;
}

static bool
attribute_bound(IndexKey *key, List *quals, Bitmapset *bound)
{
	ListCell   *lc;

	foreach(lc, quals)
	{
		OpExpr	   *op = lfirst(lc);
		Node	   *left;
		Node	   *right;

		if (!IsA(op, OpExpr) || list_length(op->args) != 2)
			continue;
		left = linitial(op->args);
		right = lsecond(op->args);
		if ((key_side(left, key, op) && is_bound(right, bound)) ||
			(key_side(right, key, op) && is_bound(left, bound)))
			return true;
	}
	return false;
}

/* Whether the quals pin every column of some unique btree index of the relation. */
static bool
relation_bound(Oid relid, Index varno, List *quals, Bitmapset *bound)
{
	Relation	rel = table_open(relid, AccessShareLock);
	List	   *indexes = RelationGetIndexList(rel);
	ListCell   *lc;
	bool		result = false;

	foreach(lc, indexes)
	{
		Relation	index = index_open(lfirst_oid(lc), AccessShareLock);
		Form_pg_index form = index->rd_index;
		List	   *predicate;
		bool		pinned;

		pinned = form->indisunique && form->indimmediate && form->indisvalid &&
			index->rd_rel->relam == BTREE_AM_OID &&
			RelationGetIndexExpressions(index) == NIL;

		if (pinned)
		{
			predicate = copyObject(RelationGetIndexPredicate(index));
			ChangeVarNodes((Node *) predicate, 1, varno, 0);
			pinned = predicate == NIL || predicate_implied_by(predicate, quals, false);
		}

		for (int k = 0; pinned && k < IndexRelationGetNumberOfKeyAttributes(index); k++)
		{
			IndexKey	key = {varno, form->indkey.values[k], index->rd_opfamily[k], index->rd_indcollation[k]};

			pinned = attribute_bound(&key, quals, bound);
		}

		index_close(index, AccessShareLock);
		if (pinned)
		{
			result = true;
			break;
		}
	}

	table_close(rel, AccessShareLock);
	return result;
}

static void
add_scoped(List **scoped, Node *quals, Bitmapset *rels)
{
	ListCell   *lc;

	foreach(lc, make_ands_implicit((Expr *) quals))
	{
		ScopedQual *sq = palloc(sizeof(ScopedQual));

		sq->qual = lfirst(lc);
		sq->rels = rels;
		*scoped = lappend(*scoped, sq);
	}
}

/* Collects the relations of a from tree and each qual with the relations it filters. */
static Bitmapset *
collect_from(Node *node, List **refs, List **scoped, bool *full_join)
{
	ListCell   *lc;
	Bitmapset  *rels = NULL;

	if (node == NULL)
		return NULL;
	if (IsA(node, RangeTblRef))
	{
		*refs = lappend_int(*refs, ((RangeTblRef *) node)->rtindex);
		return bms_make_singleton(((RangeTblRef *) node)->rtindex);
	}
	if (IsA(node, FromExpr))
	{
		FromExpr   *from = (FromExpr *) node;

		foreach(lc, from->fromlist)
			rels = bms_union(rels, collect_from(lfirst(lc), refs, scoped, full_join));
		add_scoped(scoped, from->quals, rels);
		return rels;
	}
	if (IsA(node, JoinExpr))
	{
		JoinExpr   *join = (JoinExpr *) node;
		Bitmapset  *left = collect_from(join->larg, refs, scoped, full_join);
		Bitmapset  *right = collect_from(join->rarg, refs, scoped, full_join);

		switch (join->jointype)
		{
			case JOIN_INNER:
				add_scoped(scoped, join->quals, bms_union(left, right));
				break;
			case JOIN_LEFT:
				add_scoped(scoped, join->quals, right);
				break;
			case JOIN_RIGHT:
				add_scoped(scoped, join->quals, left);
				break;
			default:
				*full_join = true;
				break;
		}
		return bms_union(left, right);
	}
	return NULL;
}

static bool
functions_return_one_row(RangeTblEntry *rte)
{
	ListCell   *lc;

	foreach(lc, rte->functions)
	{
		if (expression_returns_set(((RangeTblFunction *) lfirst(lc))->funcexpr))
			return false;
	}
	return true;
}

static bool
cte_at_most_one_row(RangeTblEntry *rte, Scope *scope)
{
	Scope	   *cte_scope;
	CommonTableExpr *cte = rte->self_reference ? NULL : find_cte(scope, rte, &cte_scope);

	return cte != NULL && !cte->cterecursive &&
		query_row_bound((Query *) cte->ctequery, cte_scope) != ROWS_MANY;
}

/* A from clause of sources that each yield exactly one row, with nothing to filter them, yields exactly one row. */
static bool
from_exactly_one_row(Query *query, Scope *scope, List *refs, List *scoped)
{
	ListCell   *lc;

	if (scoped != NIL)
		return false;
	foreach(lc, refs)
	{
		RangeTblEntry *rte = rt_fetch(lfirst_int(lc), query->rtable);

		switch (rte->rtekind)
		{
			case RTE_SUBQUERY:
				if (query_row_bound(rte->subquery, scope) != ROWS_ONE)
					return false;
				break;
			case RTE_VALUES:
				if (list_length(rte->values_lists) != 1)
					return false;
				break;
			case RTE_FUNCTION:
				if (!functions_return_one_row(rte))
					return false;
				break;
			default:
				return false;
		}
	}
	return true;
}

static RowBound
from_row_bound(Query *query, Scope *scope)
{
	List	   *refs = NIL;
	List	   *scoped = NIL;
	bool		full_join = false;
	Bitmapset  *bound = NULL;
	bool		changed = true;
	ListCell   *lc;

	collect_from((Node *) query->jointree, &refs, &scoped, &full_join);
	if (full_join)
		return ROWS_MANY;
	if (from_exactly_one_row(query, scope, refs, scoped))
		return ROWS_ONE;

	while (changed)
	{
		changed = false;
		foreach(lc, refs)
		{
			int			rtindex = lfirst_int(lc);
			RangeTblEntry *rte;
			bool		pinned = false;

			if (bms_is_member(rtindex, bound))
				continue;
			rte = rt_fetch(rtindex, query->rtable);
			switch (rte->rtekind)
			{
				case RTE_RELATION:
					pinned = !(rte->inh && has_subclass(rte->relid)) &&
						relation_bound(rte->relid, rtindex, quals_for(scoped, rtindex), bound);
					break;
				case RTE_SUBQUERY:
					pinned = query_row_bound(rte->subquery, scope) != ROWS_MANY;
					break;
				case RTE_CTE:
					pinned = cte_at_most_one_row(rte, scope);
					break;
				case RTE_VALUES:
					pinned = list_length(rte->values_lists) == 1;
					break;
				case RTE_FUNCTION:
					pinned = functions_return_one_row(rte);
					break;
				default:
					break;
			}
			if (pinned)
			{
				bound = bms_add_member(bound, rtindex);
				changed = true;
			}
		}
	}

	foreach(lc, refs)
	{
		if (!bms_is_member(lfirst_int(lc), bound))
			return ROWS_MANY;
	}
	return ROWS_MAYBE;
}

static RowBound
apply_limit(Query *query, RowBound card)
{
	Node	   *count = query->limitCount;

	if (query->limitOffset != NULL && card == ROWS_ONE)
		card = ROWS_MAYBE;
	if (count == NULL || query->limitOption == LIMIT_OPTION_WITH_TIES)
		return card;
	if (IsA(count, FuncExpr) && ((FuncExpr *) count)->funcformat == COERCE_IMPLICIT_CAST &&
		list_length(((FuncExpr *) count)->args) == 1 &&
		IsA(linitial(((FuncExpr *) count)->args), Const) &&
		((Const *) linitial(((FuncExpr *) count)->args))->consttype == INT4OID)
		count = linitial(((FuncExpr *) count)->args);
	if (IsA(count, Const) && !((Const *) count)->constisnull &&
		(((Const *) count)->consttype == INT8OID || ((Const *) count)->consttype == INT4OID))
	{
		int64		value = ((Const *) count)->consttype == INT8OID
			? DatumGetInt64(((Const *) count)->constvalue)
			: DatumGetInt32(((Const *) count)->constvalue);

		if (value > 1)
			return card;
		if (value == 1)
			return card == ROWS_ONE ? ROWS_ONE : ROWS_MAYBE;
		return ROWS_MAYBE;
	}
	return card == ROWS_ONE ? ROWS_MAYBE : card;
}

static RowBound
select_row_bound(Query *query, Scope *scope)
{
	RowBound card;

	if (query->setOperations != NULL || query->hasTargetSRFs ||
		query->groupClause != NIL || query->groupingSets != NIL)
		return ROWS_MANY;

	if (query->hasAggs)
		card = ROWS_ONE;
	else if (query->jointree->fromlist == NIL)
		card = query->jointree->quals == NULL ? ROWS_ONE : ROWS_MAYBE;
	else
		card = from_row_bound(query, scope);

	if (query->havingQual != NULL && card == ROWS_ONE)
		card = ROWS_MAYBE;
	return apply_limit(query, card);
}

/* A BEFORE or INSTEAD OF row trigger that may hand back NULL drops the row; partitions carry triggers of their own. */
static bool
before_row_trigger_may_skip(Query *query)
{
	RangeTblEntry *rte = rt_fetch(query->resultRelation, query->rtable);
	Relation	rel = table_open(rte->relid, AccessShareLock);
	TriggerDesc *triggers = rel->trigdesc;
	bool		upsert = query->onConflict != NULL && query->onConflict->action == ONCONFLICT_UPDATE;
	bool		may_skip = rel->rd_rel->relkind == RELKIND_PARTITIONED_TABLE;

	for (int i = 0; triggers != NULL && i < triggers->numtriggers && !may_skip; i++)
	{
		Trigger    *trigger = &triggers->triggers[i];
		int16		type = trigger->tgtype;

		may_skip = trigger->tgenabled != TRIGGER_DISABLED && TRIGGER_FOR_ROW(type) &&
			(TRIGGER_FOR_BEFORE(type) || TRIGGER_FOR_INSTEAD(type)) &&
			(TRIGGER_FOR_INSERT(type) || (upsert && TRIGGER_FOR_UPDATE(type))) &&
			trigger_may_return_null(trigger->tgfoid);
	}

	table_close(rel, AccessShareLock);
	return may_skip;
}

static RowBound
query_row_bound(Query *query, Scope *parent)
{
	Scope		scope = {query, parent, NIL, false};

	switch (query->commandType)
	{
		case CMD_SELECT:
			return select_row_bound(query, &scope);
		case CMD_INSERT:
			{
				RowBound card = ROWS_ONE;

				if (query->jointree->fromlist != NIL)
				{
					RangeTblRef *ref = linitial(query->jointree->fromlist);
					RangeTblEntry *rte = rt_fetch(ref->rtindex, query->rtable);

					if (rte->rtekind == RTE_VALUES)
						card = list_length(rte->values_lists) == 1 ? ROWS_ONE : ROWS_MANY;
					else if (rte->rtekind == RTE_SUBQUERY)
						card = query_row_bound(rte->subquery, &scope);
					else
						card = ROWS_MANY;
				}
				if (query->onConflict != NULL && card == ROWS_ONE &&
					(query->onConflict->action == ONCONFLICT_NOTHING ||
					 query->onConflict->onConflictWhere != NULL))
					card = ROWS_MAYBE;
				if (card == ROWS_ONE && before_row_trigger_may_skip(query))
					card = ROWS_MAYBE;
				return card;
			}
		case CMD_UPDATE:
		case CMD_DELETE:
			return from_row_bound(query, &scope) == ROWS_MANY ? ROWS_MANY : ROWS_MAYBE;
		default:
			return ROWS_MANY;
	}
}

static const char *
row_bound_name(RowBound card)
{
	switch (card)
	{
		case ROWS_ONE:
			return "one";
		case ROWS_MAYBE:
			return "maybe";
		default:
			return "many";
	}
}

/* Whether an array-valued expression may hold NULL elements. */
static bool
element_nullable(Node *node, Scope *scope, Params *params)
{
	ListCell   *lc;

	while (node != NULL && (IsA(node, RelabelType) || IsA(node, NamedArgExpr) ||
							IsA(node, CollateExpr) || IsA(node, CoerceToDomain)))
		node = IsA(node, RelabelType) ? (Node *) ((RelabelType *) node)->arg
			: IsA(node, NamedArgExpr) ? (Node *) ((NamedArgExpr *) node)->arg
			: IsA(node, CollateExpr) ? (Node *) ((CollateExpr *) node)->arg
			: (Node *) ((CoerceToDomain *) node)->arg;
	if (node == NULL)
		return true;

	switch (nodeTag(node))
	{
		case T_Const:
			{
				Const	   *c = (Const *) node;

				return c->constisnull || !type_is_array(c->consttype) ||
					array_contains_nulls(DatumGetArrayTypeP(c->constvalue));
			}
		case T_ArrayExpr:
			return ((ArrayExpr *) node)->multidims ||
				any_nullable(((ArrayExpr *) node)->elements, scope, params);
		case T_ArrayCoerceExpr:
			return element_nullable((Node *) ((ArrayCoerceExpr *) node)->arg, scope, params);
		case T_CoalesceExpr:
			foreach(lc, ((CoalesceExpr *) node)->args)
			{
				if (element_nullable(lfirst(lc), scope, params))
					return true;
			}
			return false;
		case T_Aggref:
			{
				Aggref	   *agg = (Aggref *) node;
				TargetEntry *arg;

				if (!is_builtin(agg->aggfnoid, "array_agg") || list_length(agg->args) != 1 ||
					agg->agglevelsup != 0)
					return true;
				arg = linitial(agg->args);
				if (type_is_array(exprType((Node *) arg->expr)))
					return true;
				if (agg->aggfilter != NULL &&
					predicate_implied_by(is_not_null((Node *) arg->expr),
										 make_ands_implicit(agg->aggfilter), false))
					return false;
				return expr_nullable((Node *) arg->expr, scope, params);
			}
		case T_SubLink:
			{
				SubLink    *link = (SubLink *) node;
				Query	   *sub = (Query *) link->subselect;
				Scope		inner = {sub, scope, NIL, false};

				if (link->subLinkType == ARRAY_SUBLINK)
					return column_nullable(sub, 0, scope, params);
				if (link->subLinkType == EXPR_SUBLINK && sub->setOperations == NULL)
					return element_nullable((Node *) ((TargetEntry *) linitial(sub->targetList))->expr,
											&inner, params);
				return true;
			}
		case T_Var:
			{
				Var		   *var = (Var *) node;
				Scope	   *owner = scope_up(scope, var->varlevelsup);
				RangeTblEntry *rte = rt_fetch(var->varno, owner->query->rtable);
				int			index = var->varattno - 1;

				switch (rte->rtekind)
				{
					case RTE_RELATION:
						/* Nothing in the catalog rules NULL elements out of a stored array; the writer is trusted. */
						return false;
					case RTE_SUBQUERY:
						{
							Scope		inner = {rte->subquery, owner, NIL, false};
							TargetEntry *te = list_nth(rte->subquery->targetList, index);

							return rte->subquery->setOperations != NULL ||
								element_nullable((Node *) te->expr, &inner, params);
						}
					case RTE_JOIN:
						return element_nullable(list_nth(rte->joinaliasvars, index), owner, params);
					case RTE_CTE:
						{
							Scope	   *cte_scope;
							CommonTableExpr *cte = rte->self_reference ? NULL : find_cte(owner, rte, &cte_scope);
							Query	   *body = cte != NULL ? (Query *) cte->ctequery : NULL;
							Scope		inner = {body, cte_scope, NIL, false};

							if (body == NULL || cte->cterecursive || body->setOperations != NULL ||
								body->commandType != CMD_SELECT)
								return true;
							return element_nullable((Node *) ((TargetEntry *) list_nth(body->targetList, index))->expr,
													&inner, params);
						}
					default:
						return true;
				}
			}
		default:
			return true;
	}
}

PG_FUNCTION_INFO_V1(pg_describe);

Datum
pg_describe(PG_FUNCTION_ARGS)
{
	char	   *sql = text_to_cstring(PG_GETARG_TEXT_PP(0));
	Oid		   *param_types = NULL;
	int			param_count = 0;
	Query	   *query = analyze(sql, &param_types, &param_count);
	Params		params = {param_count, palloc0(sizeof(bool) * Max(param_count, 1))};
	Scope		top = {query, NULL, NIL, false};
	StringInfoData out;
	ListCell   *lc;
	int			index = 0;

	for (int i = 0; i < param_count; i++)
	{
		if (param_types[i] == InvalidOid || param_types[i] == UNKNOWNOID)
			ereport(ERROR,
					(errcode(ERRCODE_INDETERMINATE_DATATYPE),
					 errmsg("could not determine data type of parameter $%d", i + 1)));
	}

	param_walker((Node *) query, &params);

	initStringInfo(&out);
	appendStringInfoString(&out, "{\"params\":[");
	for (int i = 0; i < param_count; i++)
		appendStringInfo(&out, "%s{\"type\":%u,\"nullable\":%s}", i > 0 ? "," : "",
						 param_types[i], params.nullable[i] ? "true" : "false");

	appendStringInfo(&out, "],\"rows\":\"%s\",\"columns\":[",
					 row_bound_name(query_row_bound(query, NULL)));
	foreach(lc, output_list(query))
	{
		TargetEntry *te = lfirst(lc);

		if (te->resjunk)
			continue;
		appendStringInfo(&out, "%s{\"name\":", index > 0 ? "," : "");
		escape_json(&out, te->resname != NULL ? te->resname : "?column?");
		appendStringInfo(&out, ",\"type\":%u,\"nullable\":%s",
						 exprType((Node *) te->expr),
						 column_nullable(query, index, NULL, &params) ? "true" : "false");
		if (get_element_type(exprType((Node *) te->expr)) != InvalidOid)
			appendStringInfo(&out, ",\"elementNullable\":%s",
							 element_nullable((Node *) te->expr, &top, &params) ? "true" : "false");
		appendStringInfoString(&out, "}");
		index++;
	}
	appendStringInfoString(&out, "]}");

	PG_RETURN_TEXT_P(cstring_to_text(out.data));
}
