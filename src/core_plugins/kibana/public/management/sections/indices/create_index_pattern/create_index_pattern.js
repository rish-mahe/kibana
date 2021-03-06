import _ from 'lodash';
import { IndexPatternMissingIndices } from 'ui/errors';
import 'ui/directives/validate_index_name';
import 'ui/directives/auto_select_if_only_one';
import { RefreshKibanaIndex } from '../refresh_kibana_index';
import uiRoutes from 'ui/routes';
import { uiModules } from 'ui/modules';
import template from './create_index_pattern.html';
import { getDefaultPatternForInterval } from './get_default_pattern_for_interval';
import { sendCreateIndexPatternRequest } from './send_create_index_pattern_request';
import { pickCreateButtonText } from './pick_create_button_text';

uiRoutes
.when('/management/kibana/index', {
  template,
});

uiModules.get('apps/management')
.controller('managementIndicesCreate', function ($scope, kbnUrl, Private, Notifier, indexPatterns, es, config, Promise, $translate) {
  const notify = new Notifier();
  const refreshKibanaIndex = Private(RefreshKibanaIndex);
  const intervals = indexPatterns.intervals;
  let samplePromise;
  let loadingCount = 0;

  // Configure the new index pattern we're going to create.
  this.formValues = {
    name: config.get('indexPattern:placeholder'),
    nameIsPattern: false,
    expandable: false,
    nameInterval: _.find(intervals, { name: 'daily' }),
    timeFieldOption: null,
  };

  // UI state.
  this.timeFieldOptions = [];
  this.timeFieldOptionsError = null;
  this.sampleCount = 5;
  this.samples = null;
  this.existing = null;
  this.nameIntervalOptions = intervals;
  this.patternErrors = [];

  const getTimeFieldOptions = () => {
    const missingPattern = !this.formValues.name;
    const missingInterval = this.formValues.nameIsPattern && !this.formValues.nameInterval;
    if (missingPattern || missingInterval)  {
      return Promise.resolve({ options: [] });
    }

    loadingCount += 1;
    return indexPatterns.mapper.clearCache(this.formValues.name)
    .then(() => {
      const pattern = mockIndexPattern(this.formValues);

      return indexPatterns.mapper.getFieldsForIndexPattern(pattern, {
        skipIndexPatternCache: true,
      });
    })
    .then(fields => {
      const dateFields = fields.filter(field => field.type === 'date');

      if (dateFields.length === 0) {
        return {
          options: [
            {
              display: $translate.instant('KIBANA-INDICES_DONT_CONTAIN_TIME_FIELDS')
            }
          ]
        };
      }

      return {
        options: [
          {
            display: $translate.instant('KIBANA-NO_DATE_FIELD_DESIRED')
          },
          ...dateFields.map(field => ({
            display: field.name,
            fieldName: field.name
          })),
        ]
      };
    })
    .catch(err => {
      if (err instanceof IndexPatternMissingIndices) {
        return {
          error: $translate.instant('KIBANA-INDICES_MATCH_PATTERN')
        };
      }

      throw err;
    })
    .finally(() => {
      loadingCount -= 1;
    });
  };

  const findTimeFieldOption = match => {
    if (!match) return;

    return this.timeFieldOptions.find(option => (
      // comparison is not done with _.isEqual() because options get a unique
      // `$$hashKey` tag attached to them by ng-repeat
      option.fieldName === match.fieldName &&
        option.display === match.display
    ));
  };

  const pickDefaultTimeFieldOption = () => {
    const noOptions = this.timeFieldOptions.length === 0;
    // options that represent a time field
    const fieldOptions = this.timeFieldOptions.filter(option => !!option.fieldName);
    // options like "I don't want the time filter" or "There are no date fields"
    const nonFieldOptions = this.timeFieldOptions.filter(option => !option.fieldName);
    // if there are multiple field or non-field options then we can't select a default, the user must choose
    const tooManyOptions = fieldOptions.length > 1 || nonFieldOptions.length > 1;

    if (noOptions || tooManyOptions) {
      return null;
    }

    if (fieldOptions.length === 1) {
      return fieldOptions[0];
    }

    return nonFieldOptions[0];
  };

  const resetIndex = () => {
    this.patternErrors = [];
    this.samples = null;
    this.existing = null;
  };

  function mockIndexPattern(index) {
    // trick the mapper into thinking this is an indexPattern
    return {
      id: index.name,
      intervalName: index.nameInterval
    };
  }

  const updateSamples = () => {
    const patternErrors = [];

    if (!this.formValues.nameInterval || !this.formValues.name) {
      return Promise.resolve();
    }

    const pattern = mockIndexPattern(this.formValues);

    loadingCount += 1;
    return indexPatterns.mapper.getIndicesForIndexPattern(pattern)
      .catch(err => {
        if (err instanceof IndexPatternMissingIndices) return;
        notify.error(err);
      })
      .then(existing => {
        const all = _.get(existing, 'all', []);
        const matches = _.get(existing, 'matches', []);

        if (all.length) {
          return this.existing = {
            all,
            matches,
            matchPercent: Math.round((matches.length / all.length) * 100) + '%',
            failures: _.difference(all, matches)
          };
        }

        patternErrors.push($translate.instant('KIBANA-PATTERN_DOES_NOT_MATCH_EXIST_INDICES'));
        const radius = Math.round(this.sampleCount / 2);
        const samples = intervals.toIndexList(this.formValues.name, this.formValues.nameInterval, -radius, radius);

        if (_.uniq(samples).length !== samples.length) {
          patternErrors.push($translate.instant('KIBANA-INVALID_NON_UNIQUE_INDEX_NAME_CREATED'));
        } else {
          this.samples = samples;
        }

        throw patternErrors;
      })
      .finally(() => {
        loadingCount -= 1;
      });
  };

  this.canExpandIndices = () => {
    // to maximize performance in the digest cycle, move from the least
    // expensive operation to most
    return !this.formValues.nameIsPattern && _.includes(this.formValues.name, '*');
  };

  this.isLoading = () => {
    return loadingCount > 0;
  };

  this.refreshTimeFieldOptions = () => {
    const prevOption = this.formValues.timeFieldOption;

    loadingCount += 1;
    this.timeFieldOptions = [];
    this.timeFieldOptionsError = null;
    this.formValues.timeFieldOption = null;
    getTimeFieldOptions()
      .then(({ options, error }) => {
        this.timeFieldOptions = options;
        this.timeFieldOptionsError = error;
        if (!this.timeFieldOptions) {
          return;
        }

        // Restore the preivously selected state, or select the default option in the UI
        const restoredOption = findTimeFieldOption(prevOption);
        const defaultOption = pickDefaultTimeFieldOption();
        this.formValues.timeFieldOption = restoredOption || defaultOption;
      })
      .catch(notify.error)
      .finally(() => {
        loadingCount -= 1;
      });
  };

  this.createIndexPattern = () => {
    const {
      name,
      timeFieldOption,
      nameIsPattern,
      nameInterval,
      expandable
    } = this.formValues;

    const id = name;

    const timeFieldName = timeFieldOption
      ? timeFieldOption.fieldName
      : undefined;

    // this seems wrong, but it's the original logic... https://git.io/vHYFo
    const notExpandable = (!expandable && this.canExpandIndices())
      ? true
      : undefined;

    // Only event-time-based index patterns set an intervalName.
    const intervalName = (nameIsPattern && nameInterval)
      ? nameInterval.name
      : undefined;

    loadingCount += 1;
    sendCreateIndexPatternRequest(indexPatterns, {
      id,
      timeFieldName,
      intervalName,
      notExpandable,
    }).then(createdId => {
      if (!createdId) {
        return;
      }

      refreshKibanaIndex().then(() => {
        if (!config.get('defaultIndex')) {
          config.set('defaultIndex', id);
        }

        indexPatterns.cache.clear(id);
        kbnUrl.change(`/management/kibana/indices/${id}`);

        // force loading while kbnUrl.change takes effect
        loadingCount = Infinity;
      });
    }).catch(err => {
      if (err instanceof IndexPatternMissingIndices) {
        return notify.error($translate.instant('KIBANA-NO_INDICES_MATCHING_PATTERN'));
      }

      notify.fatal(err);
    }).finally(() => {
      loadingCount -= 1;
    });
  };

  $scope.$watchMulti([
    'controller.formValues.nameIsPattern',
    'controller.formValues.nameInterval.name'
  ], (newVal, oldVal) => {
    const nameIsPattern = newVal[0];
    const newDefault = getDefaultPatternForInterval(newVal[1]);
    const oldDefault = getDefaultPatternForInterval(oldVal[1]);

    if (this.formValues.name === oldDefault) {
      this.formValues.name = newDefault;
    }

    if (!nameIsPattern) {
      delete this.formValues.nameInterval;
    } else {
      this.formValues.nameInterval = this.formValues.nameInterval || intervals.byName.days;
      this.formValues.name = this.formValues.name || getDefaultPatternForInterval(this.formValues.nameInterval);
    }
  });

  this.moreSamples = andUpdate => {
    this.sampleCount += 5;
    if (andUpdate) updateSamples();
  };

  $scope.$watchMulti([
    'controller.formValues.name',
    'controller.formValues.nameInterval'
  ], (newVal, oldVal) => {
    function promiseMatch(lastPromise, cb) {
      if (lastPromise === samplePromise) {
        cb();
      } else if (samplePromise != null) {
        // haven't hit the last promise yet, reset index params
        resetIndex();
      }
    }

    let lastPromise;
    resetIndex();
    samplePromise = lastPromise = updateSamples()
    .then(() => {
      promiseMatch(lastPromise, () => {
        this.samples = null;
        this.patternErrors = [];
      });
    })
    .catch(errors => {
      promiseMatch(lastPromise, () => {
        this.existing = null;
        this.patternErrors = errors;
      });
    })
    .finally(() => {
      // prevent running when no change happened (ie, first watcher call)
      if (!_.isEqual(newVal, oldVal)) {
        this.refreshTimeFieldOptions();
      }
    });
  });

  $scope.$watchMulti([
    'controller.sampleCount'
  ], () => {
    this.refreshTimeFieldOptions();
  });

  $scope.$watchMulti([
    'controller.isLoading()',
    'form.name.$error.indexNameInput',
    'controller.formValues.timeFieldOption'
  ], ([loading, invalidIndexName, timeFieldOption]) => {
    const state = { loading, invalidIndexName, timeFieldOption };
    this.createButtonText = pickCreateButtonText($translate, state);
  });
});
