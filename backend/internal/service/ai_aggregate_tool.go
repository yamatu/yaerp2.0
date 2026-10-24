package service

import (
	"fmt"
	"math"
	"sort"
	"strings"
)

const (
	aggregateMaxGroupColumns = 3
	aggregateMaxMetrics      = 8
	aggregateDefaultLimit    = 50
	aggregateMaxLimit        = 500
)

type aggregateMetric struct {
	ColumnKey string
	Op        string
	Label     string
}

type aggregateAccumulator struct {
	sum      float64
	numeric  int
	nonEmpty int
	min      float64
	max      float64
}

// toolAggregateSheetRows groups the rows the employee can see by one or more
// columns and computes sum/avg/count/min/max per group over the whole sheet,
// so totals such as "profit by product" are exact instead of being added up by
// the model from a page of rows.
func (s *AIService) toolAggregateSheetRows(userID int64, args map[string]any) (*toolExecutionResult, error) {
	sheetID, err := int64Arg(args, "sheet_id")
	if err != nil {
		return nil, err
	}
	if err := s.ensureSheetViewAccess(userID, sheetID); err != nil {
		return nil, err
	}
	sheet, err := s.sheetRepo.GetSheet(sheetID)
	if err != nil {
		return nil, err
	}
	columns, err := parseSheetColumns(sheet.Columns)
	if err != nil {
		return nil, err
	}
	resolve := func(reference, field string) (string, error) {
		key, _ := resolveColumnReference(reference, columns)
		if key == "" {
			return "", fmt.Errorf("%s 的列 %q 不存在；可用列：%s", field, reference, describeColumnKeys(columns))
		}
		return key, nil
	}

	groupBy := make([]string, 0, aggregateMaxGroupColumns)
	for _, reference := range stringSliceArg(args, "group_by") {
		key, err := resolve(reference, "group_by")
		if err != nil {
			return nil, err
		}
		groupBy = append(groupBy, key)
	}
	if len(groupBy) > aggregateMaxGroupColumns {
		return nil, fmt.Errorf("group_by 最多 %d 列", aggregateMaxGroupColumns)
	}

	metrics := make([]aggregateMetric, 0, aggregateMaxMetrics)
	rawMetrics, _ := args["metrics"].([]any)
	for index, item := range rawMetrics {
		entry, ok := item.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("metrics[%d] 必须是 {column_key, op} 对象", index)
		}
		op := strings.ToLower(strings.TrimSpace(fmt.Sprint(entry["op"])))
		switch op {
		case "sum", "avg", "min", "max", "count", "count_non_empty":
		default:
			return nil, fmt.Errorf("metrics[%d] 的 op 只能是 sum、avg、min、max、count、count_non_empty", index)
		}
		metric := aggregateMetric{Op: op}
		if reference := strings.TrimSpace(fmt.Sprint(entry["column_key"])); op != "count" || (reference != "" && reference != "<nil>") {
			if metric.ColumnKey, err = resolve(reference, fmt.Sprintf("metrics[%d]", index)); err != nil {
				return nil, err
			}
		}
		metric.Label = op
		if metric.ColumnKey != "" {
			metric.Label = fmt.Sprintf("%s(%s)", op, metric.ColumnKey)
		}
		metrics = append(metrics, metric)
	}
	if len(metrics) == 0 {
		metrics = append(metrics, aggregateMetric{Op: "count", Label: "count"})
	}
	if len(metrics) > aggregateMaxMetrics {
		return nil, fmt.Errorf("metrics 最多 %d 项", aggregateMaxMetrics)
	}

	var conditions []filterCondition
	if _, ok := args["conditions"]; ok {
		if conditions, err = parseFilterConditions(args); err != nil {
			return nil, err
		}
		for index, condition := range conditions {
			if conditions[index].ColumnKey, err = resolve(condition.ColumnKey, fmt.Sprintf("conditions[%d]", index)); err != nil {
				return nil, err
			}
		}
	}

	rows, err := s.loadAgentRows(sheet)
	if err != nil {
		return nil, err
	}
	if columns, rows, err = scopeAgentRead(args, sheet, columns, rows); err != nil {
		return nil, err
	}
	visible, err := s.readSheetRowValues(userID, sheet, columns, rows)
	if err != nil {
		return nil, err
	}
	readKeys := append([]string{}, groupBy...)
	for _, metric := range metrics {
		if metric.ColumnKey != "" {
			readKeys = append(readKeys, metric.ColumnKey)
		}
	}
	for _, condition := range conditions {
		readKeys = append(readKeys, condition.ColumnKey)
	}
	if err := ensureColumnsInScope(args, columns, readKeys); err != nil {
		return nil, err
	}
	// A hidden value must not silently count as blank in a total.
	if err := ensureReadColumnsVisible(buildAIPreviewRows(sheet, columns, rows), visible, readKeys); err != nil {
		return nil, err
	}

	type group struct {
		values map[string]any
		rows   int
		acc    []aggregateAccumulator
	}
	groups := map[string]*group{}
	order := make([]string, 0)
	matchedRows := 0
	for _, row := range visible {
		if len(row.Data) == 0 || (len(conditions) > 0 && !sheetValuesMatch(row.Data, conditions)) {
			continue
		}
		matchedRows++
		parts := make([]string, len(groupBy))
		values := make(map[string]any, len(groupBy))
		for index, key := range groupBy {
			text := strings.TrimSpace(fmt.Sprint(row.Data[key]))
			if row.Data[key] == nil || text == "" {
				text = "（空）"
			}
			parts[index] = text
			values[key] = text
		}
		groupKey := strings.Join(parts, "\x1f")
		current := groups[groupKey]
		if current == nil {
			current = &group{values: values, acc: make([]aggregateAccumulator, len(metrics))}
			groups[groupKey] = current
			order = append(order, groupKey)
		}
		current.rows++
		for index, metric := range metrics {
			if metric.ColumnKey == "" {
				continue
			}
			value, exists := row.Data[metric.ColumnKey]
			if !exists || value == nil || strings.TrimSpace(fmt.Sprint(value)) == "" {
				continue
			}
			acc := &current.acc[index]
			acc.nonEmpty++
			number, ok := toFloat64(value)
			if !ok || math.IsNaN(number) || math.IsInf(number, 0) {
				continue
			}
			if acc.numeric == 0 || number < acc.min {
				acc.min = number
			}
			if acc.numeric == 0 || number > acc.max {
				acc.max = number
			}
			acc.sum += number
			acc.numeric++
		}
	}

	metricValue := func(metric aggregateMetric, rowsInGroup int, acc aggregateAccumulator) any {
		switch metric.Op {
		case "count":
			if metric.ColumnKey == "" {
				return rowsInGroup
			}
			return acc.nonEmpty
		case "count_non_empty":
			return acc.nonEmpty
		}
		if acc.numeric == 0 {
			return nil
		}
		switch metric.Op {
		case "sum":
			return roundAggregate(acc.sum)
		case "avg":
			return roundAggregate(acc.sum / float64(acc.numeric))
		case "min":
			return roundAggregate(acc.min)
		default:
			return roundAggregate(acc.max)
		}
	}

	results := make([]map[string]any, 0, len(order))
	totals := make([]aggregateAccumulator, len(metrics))
	for _, groupKey := range order {
		current := groups[groupKey]
		values := make(map[string]any, len(metrics))
		for index, metric := range metrics {
			values[metric.Label] = metricValue(metric, current.rows, current.acc[index])
			total := &totals[index]
			acc := current.acc[index]
			if acc.numeric > 0 {
				if total.numeric == 0 || acc.min < total.min {
					total.min = acc.min
				}
				if total.numeric == 0 || acc.max > total.max {
					total.max = acc.max
				}
			}
			total.sum += acc.sum
			total.numeric += acc.numeric
			total.nonEmpty += acc.nonEmpty
		}
		results = append(results, map[string]any{"group": current.values, "rows": current.rows, "metrics": values})
	}

	sortBy := strings.TrimSpace(firstStringValue(args, "sort_by"))
	if sortBy == "" {
		sortBy = metrics[0].Label
	}
	descending := true
	if value, ok := optionalBoolArg(args, "descending"); ok {
		descending = value
	}
	sortValue := func(entry map[string]any) (float64, bool) {
		if sortBy == "rows" {
			return float64(entry["rows"].(int)), true
		}
		return toFloat64(entry["metrics"].(map[string]any)[sortBy])
	}
	sort.SliceStable(results, func(i, j int) bool {
		left, leftOK := sortValue(results[i])
		right, rightOK := sortValue(results[j])
		if leftOK != rightOK {
			return leftOK
		}
		if descending {
			return left > right
		}
		return left < right
	})

	limit, _ := intArgWithDefault(args, "limit", aggregateDefaultLimit)
	if limit <= 0 || limit > aggregateMaxLimit {
		limit = aggregateDefaultLimit
	}
	truncated := len(results) > limit
	if truncated {
		results = results[:limit]
	}
	overall := make(map[string]any, len(metrics))
	for index, metric := range metrics {
		overall[metric.Label] = metricValue(metric, matchedRows, totals[index])
	}
	return &toolExecutionResult{
		Data: map[string]any{
			"ok": true, "sheet_id": sheetID, "sheet_name": sheet.Name,
			"group_by": groupBy, "matched_rows": matchedRows, "group_count": len(order),
			"groups": results, "truncated": truncated, "overall": overall, "sorted_by": sortBy,
		},
		TouchedSheetIDs: []int64{sheetID},
		Summary:         fmt.Sprintf("按 %s 分组汇总 %d 行，共 %d 组", strings.Join(groupBy, "+"), matchedRows, len(order)),
	}, nil
}

func roundAggregate(value float64) float64 {
	return math.Round(value*10000) / 10000
}
