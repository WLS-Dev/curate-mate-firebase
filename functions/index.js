'use strict'; // Mandatory js style?

// Requirements & Global vars:
const { dialogflow, Suggestions, BasicCard, Button, Carousel, List, Table, Image, SimpleResponse, BrowseCarousel, BrowseCarouselItem} = require('actions-on-google');
const dashbot = require('dashbot')('dashbot_api_key').google;
const functions = require('firebase-functions'); // Mandatory when using firebase
var striptags = require('striptags'); // For removing all text
const removeMd = require('remove-markdown'); // For removing markdown from body
const moment = require('moment'); // For timestamps

let wls = require("@whaleshares/wlsjs");
wls.api.setOptions({ url: 'wss://whaleshares.io/ws' }); // Whaleshares API URL. TODO: Configure backup servers
wls.config.set('address_prefix', 'WLS');
wls.config.set('chain_id', 'de999ada2ff7ed3d3d580381f229b40b5a0261aec48eb830e540080817b72866'); // TODO: Verify?

const app = dialogflow({
  // Creating the primary dialogflow app element
  debug: true, // For extra debug logs
  verification: {
    // Dialogflow authentication
    'key': 'value'
  }
});
dashbot.configHandler(app);

function catch_error(conv, error_message, intent) {
  /*
  Generic function for reporting errors & providing error handling for the user.
  */
  if(error_message instanceof Error) {
      console.error(error_message);
  } else {
      console.error(new Error(error_message));
  }

  return conv.close(
      new SimpleResponse({
      // If we somehow fail, do so gracefully!
      speech: "An unexpected error was encountered! Let's end our Blockchain Activity session for now.",
      text: "An unexpected error was encountered! Let's end our Blockchain Activity session for now."
    })
  );
}

function fallback_body_contents (conv, text_target, speech_target) {
  /*
    Async for fallbacks
  */
  return new Promise((resolve, reject) => {
    let fallback_text;
    let fallback_speech;

    if ((conv.data).hasOwnProperty(text_target)) {
      fallback_text = conv.data[text_target];
    } else {
      fallback_text = 'Sorry, what do you want to do next?';
    }

    if ((conv.data).hasOwnProperty(speech_target)) {
      // The
      fallback_speech = conv.data[speech_target];
    } else {
      fallback_speech = '<speak>Sorry, what do you want to do next?</speak>';
    }

    let ask_contents = [];

    const last_timestamp = new moment(conv.user.storage.last_timestamp);
    if (typeof(last_timestamp) !== 'undefined') {
      const current_timestamp = new moment();
      if ((last_timestamp.diff(current_timestamp, 'minutes')) > 10) {
        /*
          More than 10 mins have passed since the user used the bot.
          It's likely they're trying to do something unrelated, let's remind them they're using the bot!
        */
        const reminder_contents = `Still using curate mate? If not please quit.`; // How we'll remind the user they're using our bot!
        ask_contents.push(
          new SimpleResponse({
            speech: `<speak>${reminder_contents}</speak>`,
            text: reminder_contents
          })
        );
      }
    }

    ask_contents.push(
      new SimpleResponse({
        speech: fallback_speech,
        text: fallback_text
      }),
      new Suggestions([`🐋 WLS Tag List`, '🆘 Help', '🚪 Quit'])
    );

    if (ask_contents.length > 0) {
      console.log(`successful fallback prompt`);
      return resolve(ask_contents);
    } else {
      console.warn(`fallback error`);
      return reject(new Error('Failed to fallback!'));
    }
  });
}

function fallback_body (conv, fallback_name) {
  /*
    Fallback body contents
  */

  //console.warn(`fallback_body triggered! ${fallback_name}`);

  if (conv.data.fallbackCount > 1) {
    // Google best practice is to quit upon the 3rd attempt
    //console.log("User misunderstood 3 times, quitting!");
    return conv.close("Sorry, I'm having difficulty understanding. Let's try again later? Goodbye.");
  } else {
    // Within fallback attempt limit (<3)
    const text_target = 'fallback_text_' + (conv.data.fallbackCount).toString();
    const speech_target = 'fallback_speech_' + (conv.data.fallbackCount).toString();
    conv.data.fallbackCount++; // Iterate the fallback counter

    return fallback_body_contents(conv, text_target, speech_target)
    .then(results => {
      //console.warn(`A! ${results}`);
      return conv.ask(results[0]);
    })
    .catch(error_message => {
      console.warn(`Failed to produce fallback body contents for ${fallback_name}!`);
      return catch_error(conv, error_message, fallback_name);
    });
  }
  // END
}

function store_fallback_response (conv, fallback_messages, suggestions) {
  /*
    Function for storing fallback messages in the conv data storage.
  */
  // 1st fallback
  conv.data.fallback_text_0 = fallback_messages[0];
  conv.data.fallback_speech_0 = '<speak>' + fallback_messages[0] + '</speak>';
  // 2nd fallback
  conv.data.fallback_text_1 = fallback_messages[1];
  conv.data.fallback_speech_1 = '<speak>' + fallback_messages[1] + '</speak>';
  // NOTE: No 3rd fallback - we will quit!

  // Storing suggestion list as a comma seperated string
  conv.data.suggestions = suggestions.join(',');
}

function genericFallback(conv, intent_name) {
  /*
  Generic fallback function
  */
  const fallback_name = intent_name + '_Fallback';

  //console.log(util.inspect(conv, false, null)); // DEBUG function!

  if ((!(conv.data).hasOwnProperty('fallbackCount')) || (typeof(conv.data.fallbackCount) === "undefined")) {
    /*
      The user's past conversation has expired - we need to handle unprepared fallbacks.
      Both contexts and conv.data expire after a certain period of inactivity.
    */
    conv.data.fallbackCount = 0 // Set the fallback to 0, enabling genericFallback to work
  }

  if ((!(conv.data).hasOwnProperty('fallback_text_0')) || (typeof(conv.data.fallback_text_0) === "undefined")) {
    const fallback_messages = [
      "Sorry, what do you want to do next?",
      "I didn't catch that. What do you want to do next?"
    ];
    const suggestions = [`🐋 WLS Tag List`, '🆘 Help', '🚪 Quit'];
    store_fallback_response(conv, fallback_messages, suggestions);

    return fallback_body(conv, fallback_name);
  } else {
    /*
      The user has an ongoing conversation during this fallback.
      We have the required data to proceed.
    */
    return fallback_body(conv, fallback_name);
  }
}

function store_timestamp (conv) {
  // Storing the current timestamp into the conv userstorage data!
  var now = new moment();
  conv.user.storage.last_timestamp = now;
}

app.intent('Welcome', (conv) => {
  /*
    Initial landing intent for users who launch the bot by name or via the assistant store/repository.
  */
  return get_tags("", 5)
  .then(six_tags => {
    // Getting the tags
    return Promise.all(
      [
        six_tags,
        create_tag_suggestions(six_tags)
      ]
    );
  })
  .then(processed_results => {
    // Talking to the user with the generated content!

    conv.data.fallbackCount = 0; // Required for tracking fallback attempts!
    conv.user.storage.last_intent_name = 'Welcome';

    store_timestamp(conv);

    let greeting;
    if (typeof(conv.user.storage.userId) !== 'undefined') {
      // The user has been seen before.
      const greetings = [
        'Hey there, great to see you again.',
        'Welcome back.',
        'Hey, good to have you back.',
        'Oh hey, welcome back mate!',
        'Yo, welcome back!'
      ];
      greeting = greetings[Math.floor(Math.random() * greetings.length)]; // Randomly select one of the greetings
    } else {
      // Never seen the user before
      const greetings = [
        `Welcome to curate mate.`
      ];
      greeting = greetings[Math.floor(Math.random() * greetings.length)]; // Randomly select one of the greetings
    }

    const post_asks = [
      `I can help you navigate user created whaleshares content, just provide a topic and I'll fetch trending results.`,
      `Wanting to navigate some user created whaleshares content? Just provide a topic and I'll fetch some results.`,
      `For what topic do you want the latest trending whaleshares content?`,
      `So, you're interested in whaleshares? Provide me a topic and I'll serve up the latest trending content!`,
      `Alright then, what whaleshares content do you want?`,
      `What whaleshares topic do you want to read about?`
    ];
    let post_ask = post_asks[Math.floor(Math.random() * post_asks.length)];

    const fallback_messages = [
      "Sorry, what do you want to do next?",
      "I didn't catch that. What do you want to do next?"
    ];
    const suggestions = processed_results[1].concat([`🐋 WLS Tag List`, '🆘 Help', '🚪 Quit']);
    store_fallback_response(conv, fallback_messages, suggestions);

    return conv.ask(
      new SimpleResponse({
        speech: `<speak>${greeting}<break time="0.25s" /></speak>`,
        text: `${greeting}`
      }),
      new SimpleResponse({
        speech: `<speak>${post_ask}<break time="0.45s" /></speak>`,
        text: `${post_ask}`
      }),
      new Suggestions(processed_results[1], `🐋 WLS Tag List`, '🆘 Help', '🚪 Quit')
    );
  })
  .catch(error_message => {
    console.warn(`welcome fail! ${error_message}`);
    return catch_error(conv, error_message, 'Welcome');
  });

});

function getGetOrdinal(n) {
  /*
    Takes number, returns ordinal equivelant.
    Source: https://stackoverflow.com/a/31615643/9065060
  */
  var s=["th","st","nd","rd"],
  v=n%100;
  return n+(s[(v-20)%10]||s[v]||s[0]);
 }

function get_tags (last_tag, max_tags) {
  // Retrieving the latest WLS trending tags, tag limit input
  return new Promise((resolve, reject) => {

    wls.api.getTrendingTags(last_tag, max_tags, function(err, result) {
      // "" means after 'all'
      if (err || !result) { // Check for Errors
        return reject(new Error('Failed to retrieve tags!'));
      }

      var adjusted_result = result.splice(1, result.length); // Remove first entry!

      return resolve(adjusted_result);
    });
  });
}

function create_tag_suggestions (tags_json) {
  /*
    Parsing suggestions from the following tags_json:
    [{
      "name": "",
      "total_payouts": "60874815.299 SBD",
      "net_votes": 47406122,
      "top_posts": 4465742,
      "comments": 27189956,
      "trending": "99940318512"
    }]
  */
  return new Promise((resolve, reject) => {
    if ((!tags_json) || (tags_json.length === 0)) {
      // Catch failure
      return reject(new Error(`Failed to retrieve tags! ${tags_json}`));
    } else {
      // valid tags_json provided, create and return list of suggestion chips!
      let temp_result = [];

      for (let index = 0; index < tags_json.length; index++) {
        if (tags_json[index].name === "") {
          // Skip blank entries!
          continue;
        }
        temp_result.push(`🐳 ${tags_json[index].name}`);
      }

      return resolve(temp_result);
    }
  });
}

function create_tag_list (tags_json) {
  /*
    Parsing list items from the following tags_json:
    [{
      "name": "",
      "total_payouts": "60874815.299 SBD",
      "net_votes": 47406122,
      "top_posts": 4465742,
      "comments": 27189956,
      "trending": "99940318512"
    }]
  */
  //console.warn(`${tags_json.length} ${Object.keys(tags_json).length} ${typeof(tags_json)}`);
  return new Promise((resolve, reject) => {
    if (!tags_json) {
      // Fail
      return reject(new Error(`${tags_json} : 'create_tag_list' wasn't provided tags_json input!`));
    }
    if (tags_json.length < 3) {
      // Insufficient list items
      return reject(new Error(`${tags_json.length} ||||| Can't create lists with less than 3 items!`));
    } else {
      // Proceed!
      let items = {};
      for (let index = 0; index < tags_json.length; index++) {
        // Iterate over the tag json
        if (index > 29) {
          // Too many items!
          break;
        } else {
          if (tags_json[index].top_posts > 2) {
            if ((tags_json[index].name === 'nsfw')||(tags_json[index].name === 'easydex')) {
              // TODO: Make list of banned tags!
              continue;
            } else {
              // Sufficient post count, let's proceed!
              const INDEX_NUM = index.toString();
              items[INDEX_NUM] = {
                synonyms: [
                  `${tags_json[index].name}`,
                  `${getGetOrdinal(index)}`
                ],
                title: `🐳 ${tags_json[index].name}`,
                //description: `Read about '${tags_json[index].name}' on Whaleshares`,
                description: `'${tags_json[index].name}' has ${tags_json[index].top_posts} posts, ${tags_json[index].comments} comments and ${tags_json[index].total_payouts} rewards.`,
                image: new Image({
                  url: 'https://i.imgur.com/dDEwnx7.png',
                  alt: 'WLS Logo',
                })
              };
            }
          } else {
            // We cannot create a carousel with < 3 items, let's skip this entry!
            continue;
          }
        }

      }

      resolve(items);

    }
  });
}

app.intent('Tag_List', (conv) => {
  // Show the user a list of WLS trending tags in list format

  conv.data.fallbackCount = 0; // Required for tracking fallback attempts!
  conv.user.storage.last_intent_name = 'Tag_List';

  store_timestamp(conv);

  return get_tags("", 30)
  .then(tag_json => {
    conv.user.storage.last_tag_shown = tag_json.slice(-1)[0].name;
    return Promise.all(
      [
        tag_json,
        create_tag_list(tag_json)
      ]
    );
  })
  .then(current_results => {
    const original_tag_json = current_results[0];
    const tag_list = current_results[1];

    conv.contexts.set('tag_list', 1, {
      "original_tag_json": original_tag_json,
      "list_body": tag_list
    });

    return conv.ask(
      new SimpleResponse({
        speech: `<speak>Here's the latest trending whaleshares tags.</speak>`,
        text: `Here's the latest trending whaleshares tags.`
      }),
      new List({
        title: 'Trending Whaleshares tags',
        items: tag_list
      }),
      new Suggestions(['➕ More tags', '🆘 Help', '🚪 Quit'])
    );
  })
  .catch(error_message => {
    return catch_error(conv, error_message, 'Tag_List');
  });
});

app.intent('show_more_tags', (conv) => {
  /*
    The user wants to see more tags!
  */
  var last_known_tag;
  if (typeof(conv.user.storage.last_tag_shown) !== 'undefined') {
    last_known_tag = conv.user.storage.last_tag_shown;
  } else {
    last_known_tag = "";
  }

  conv.data.fallbackCount = 0; // Required for tracking fallback attempts!
  conv.user.storage.last_intent_name = 'show_more_tags';
  store_timestamp(conv);

  return get_tags(last_known_tag, 30)
  .then(tag_json => {
    conv.user.storage.last_tag_shown = tag_json.slice(-1)[0].name;
    //console.warn(`show more tags: '${tag_json.slice(-1)[0].name}'`);
    return Promise.all(
      [
        tag_json,
        create_tag_list(tag_json)
      ]
    );
  })
  .then(current_results => {
    const original_tag_json = current_results[0];
    const tag_list = current_results[1];

    //console.warn(tag_list);

    if (Object.keys(tag_list).length > 2) {
      // Minimum requirement
      conv.contexts.set('tag_list', 1, {
        "original_tag_json": original_tag_json,
        "list_body": tag_list
      });

      var simple_response_contents;
      if (last_known_tag === "") {
        simple_response_contents = {
          speech: `<speak>Here's the latest trending whaleshares tags.</speak>`,
          text: `Here's the latest trending whaleshares tags.`
        };
      } else {
        simple_response_contents = {
          speech: `<speak>Here's the next ${Object.keys(tag_list).length} trending whaleshares tags.</speak>`,
          text: `Here's the next ${Object.keys(tag_list).length} trending whaleshares tags.`
        };
      }

      return conv.ask(
        new SimpleResponse(simple_response_contents),
        new SimpleResponse({
          speech: `<speak></speak>`,
          text: `⚠ Note: These tags update more frequently than Curate Mate's supported topics; some tags may not work until the next scheduled topic entity update.`
        }),
        new List({
          title: 'Trending Whaleshares tags',
          items: tag_list
        }),
        new Suggestions('➕ More tags', '🆘 Help', '🚪 Quit')
      );
    } else {
      // We have insufficient results - let's tell them they reached the end of the line!
      return conv.ask(
        new SimpleResponse({
          speech: `<speak>Unfortunately there are no additional tags, why not try one of the previously suggested tags?</speak>`,
          text: `Unfortunately there are no additional tags, why not try one of the previously suggested tags?`
        }),
        new Suggestions(['🐳 bitshares', '🐳 whaleshares', '🐳 eos', '🐳 spanish', `🐋 WLS Tag List`, '🆘 Help', '🚪 Quit'])
      );
    }
  })
  .catch(error_message => {
    return catch_error(conv, error_message, 'show_more_tags');
  });

});

app.intent('About', (conv) => {
  // The user requested to know more about this bot
  conv.data.fallbackCount = 0; // Required for tracking fallback attempts!
  conv.user.storage.last_intent_name = 'About';

  const fallback_messages = [
    "Sorry, what do you want to do next?",
    "I didn't catch that. What do you want to do next?"
  ];
  const suggestions = [`🐋 WLS Tag List`, '🆘 Help', '🚪 Quit'];
  store_fallback_response(conv, fallback_messages, suggestions);

  store_timestamp(conv);

  const help_text = `Hey, I heard you wanted to know more about me? I can help you browse Whaleshares content, just provide a topic and I can provide links to the latest related content on the Whaleshares blockchain!`;
  conv.ask(
    new SimpleResponse({
      speech: `<speak>${help_text}</speak>`,
      text: help_text
    }),
    new SimpleResponse({
      speech: `<speak>So, what do you want to do next?</speak>`,
      text: ` So, what do you want to do next?`
    }),
    new Suggestions(suggestions)
  );
});

app.intent('Goodbye', (conv) => {
  // The user requested to leave the bot
  conv.close(
    new SimpleResponse({
      speech: `<speak>Goodbye, see you next time!</speak>`,
      text: `👋 Goodbye, see you next time!`
    })
  );
});

app.intent('input.unknown', conv => {
  /*
  Generic fallback intent used by all intents!
  */
  return genericFallback(conv, `input.unknown`);
});

function generate_browsing_carousel(input_list, post_content_list) {
  /*
    Given a 'current_target', attempt to create a browsing carousel.
    Called from the initial 'interactive_report' intent and the 'followup_interactive_report'.
  */
  return new Promise((resolve, reject) => {
    let carousel_items = []; // Creating carousel item holder

    // We've got the required exchange data to produce a carousel!
    for (let index = 0; index < input_list.length; index++) {
      // Iterate over movies in GOAT list
      const current_input_target = input_list[index];
      if (typeof(current_input_target) === "undefined") {
        // Skip invalid items!
        continue;
      }
      const current_post_contents = post_content_list[index];

      /*
        "result_id": result_id,
        "result_image": body_images,
        "result_author": result_author,
        "result_permlink": result_permlink,
        "result_title": result_title,
        "result_body": result_body,
        "result_json_metadata": result_json_metadata
      */
      /*
      */

      /*
      "id": 60198466,
      "author": "cm-steem",
      "permlink": "blockchain-activity-google-assistant-agent-updates",
      "category": "bitshares",
      "parent_author": "",
      "parent_permlink": "bitshares",
      "title": "Blockchain Activity Google Assistant agent updates",
      "json_metadata": "{\"tags\":[\"bitshares\",\"cryptocurrency\",\"programming\",\"eos\",\"google\"],\"image\":[\"https://whaleshares.io/imageupload_data/f729148ba00002b5a8f6f32281ddb0a355e833ff\",\"https://whaleshares.io/imageupload_data/84c205f7787b41c73ad31e6284f82c50d9551476\",\"https://whaleshares.io/imageupload_data/4a1ecdd7b3143dec6a532ee6c45fa7397f71f4c8\",\"https://whaleshares.io/imageupload_data/218126c5250274cc47988eae0f47b9e758e0835f\",\"https://whaleshares.io/imageupload_data/bc159ec145fe968f94a7074ab3ce0e1d1aa9ef55\",\"https://whaleshares.io/imageupload_data/77a737053cbed257cf258d84f5d172f839c23176\",\"https://cdn.steemitimages.com/DQmZm7cSeXpCRizSDJSiUJwPHeVSgPhrF8rTeMtmqatQx5S/image.png\"],\"links\":[\"https://assistant.google.com/services/a/uid/0000003e08d8dba9?hl=en-US&source=web\",\"https://whaleshares.io/bitshares/@customminer/blockchain-activity-google-assistant-agent-published-say-ok-google-talk-to-blockchain-activity\"],\"app\":\"steemit/0.1\",\"format\":\"markdown\"}",
      "last_update": "2018-08-20T13:59:42",
      "created": "2018-08-19T20:32:09",
      "active": "2018-08-24T07:34:00",
      "last_payout": "2018-08-26T20:32:09",
      "depth": 0,
      "children": 17,
      "net_rshares": 0,
      "abs_rshares": 0,
      "vote_rshares": 0,
      "children_abs_rshares": 0,
      "cashout_time": "1969-12-31T23:59:59",
      "max_cashout_time": "1969-12-31T23:59:59",
      "total_vote_weight": 0,
      "reward_weight": 10000,
      "total_payout_value": "20.110 SBD",
      "curator_payout_value": "2.260 SBD",
      "author_rewards": 22905,
      "net_votes": 47,
      "root_author": "cm-steem",
      "root_permlink": "blockchain-activity-google-assistant-agent-updates",
      "max_accepted_payout": "1000000.000 SBD",
      "percent_steem_dollars": 10000,
      "allow_replies": true,
      "allow_votes": true,
      "allow_curation_rewards": true,
      "beneficiaries": [],
      "url": "/bitshares/@cm-steem/blockchain-activity-google-assistant-agent-updates",
      "root_title": "Blockchain Activity Google Assistant agent updates",
      "pending_payout_value": "0.000 SBD",
      "total_pending_payout_value": "0.000 STEEM",
      */

      /*
        We want:
        "children": 17, // Comments
        "net_votes": 47, // Vote count
        "total_payout_value": "20.110 SBD", // Paid out already?
        "total_pending_payout_value": "0.000 STEEM", // Due to pay out?
      */
      const description = `@${current_input_target.result_author}'s post is about the following topics: ${current_input_target.result_json_metadata_tags}`;

      carousel_items[index] = new BrowseCarouselItem({
        'title': `${current_input_target.result_title}`,
        'url': `https://whaleshares.io/@${current_input_target.result_author}/${current_input_target.result_permlink}`,
        'description': description,
        'image': new Image({
          'url': current_input_target.result_image,
          'alt': `Main post image chosen by ${current_input_target.result_author}`
        }),
        'footer': `${current_post_contents.net_votes} shares & ${current_post_contents.children} comments`
      })
    }

    if (carousel_items !== []) {
      // We've generated list items
      return resolve(carousel_items);
    } else {
      // If we didn't build the list items correctly this will trigger
      return reject(new Error('Failed to create browsing carousel!'));
    }
  });
}

function get_wls_results (allowed_topics, sort_target) {
  //
  return new Promise((resolve, reject) => {
    if (sort_target === "new") {
      wls.api.getDiscussionsByCreated({"tag": allowed_topics, "limit": 10}, function(error, result) {
        if (error || !result || (typeof(result) === "undefined")) { // Check for Errors
          console.warn(`Failed to find ${allowed_topics} on WLS: ${error}`); // Output Error
        }
        //console.warn(JSON.stringify(result));
        return resolve(result);
        /*
        if (result.length >= 3) {
          return resolve(result);
        } else {
          return reject(new Error('Failed to scrape WLS!'));
        }
        */
      });
    } else {
      wls.api.getDiscussionsByTrending({"tag": allowed_topics, "limit": 10}, function(error, result) {
        if (error || !result || (typeof(result) === "undefined")) { // Check for Errors
          console.warn(`Failed to find ${allowed_topics} on WLS: ${error}, ${result}`); // Output Error
        }
        //console.warn(JSON.stringify(result));
        return resolve(result);
        /*
        if (result.length >= 3) {
          return resolve(result);
        } else {
          return reject(new Error('Failed to scrape WLS!'));
        }
        */
      });
    }
  });
}

function removeLinks(text) {
    var urlRegex =/(\b(https?|ftp|file):\/\/[-A-Z0-9+&@#\/%?=~_|!:,.;]*[-A-Z0-9+&@#\/%=~_|])/ig;
    return text.replace(urlRegex, '');
}

function parse_wls_results (result) {
  // Parsing the results from the whaleshares nework!
  return new Promise((resolve, reject) => {
    let complete_list = [];

    for (let index = 0; index < result.length; index++) {
      // Iterate over results!
      const current_target = result[index];

      if (typeof(current_target) === "undefined") {
        // Skipping invalid items!
        continue;
      }

      const result_id = current_target.id;
      const result_author = current_target.author;
      const result_permlink = current_target.permlink;
      const result_title = current_target.title;
      const result_json_metadata_tags = ((JSON.parse(current_target.json_metadata)).tags).join(', ');
      //console.warn(current_target.json_metadata);
      const body_images = 'https://whaleshares.io/images/logo.png';
      const result_json_metadata_images = (JSON.parse(current_target.json_metadata)).image;

      let chosen_image;
      if (typeof(result_json_metadata_images) !== 'undefined') {
        if (result_json_metadata_images.length > 0) {
          chosen_image = result_json_metadata_images[0];
        } else {
          chosen_image = body_images;
        }
      } else {
        chosen_image = body_images;
      }

      let result_body = removeLinks(removeMd(striptags(current_target.body))); // Removing all tags and markdown for increased safety!

      result_body.replace('.jpeg', '');
      result_body.replace('.jpg', '');
      result_body.replace('.gif', '');
      result_body.replace('.png', '');
      result_body.replace('.mp4', '');

      complete_list.push({
        "result_id": result_id,
        "result_image": chosen_image,
        "result_author": result_author,
        "result_permlink": result_permlink,
        "result_title": result_title,
        "result_body": result_body,
        "result_json_metadata_tags": result_json_metadata_tags
      });
    }

    if (complete_list.length > 2) {
      // We've generated list items
      return resolve(complete_list);
    } else {
      // If we didn't build the list items correctly this will trigger
      //return reject(new Error('Failed to parse WLS results!'));
      const fallback_messages = [
        "Sorry, that topic doesn't have sufficient results, try another?",
        "Sorry again, please provide a different topic or try viewing the 'WLS Tag List' for help."
      ];
      const suggestions = [`🐋 WLS Tag List`, '🆘 Help', '🚪 Quit'];
      store_fallback_response(conv, fallback_messages, suggestions);
      return genericFallback(conv, `show_carousel`);
    }

  });
}

app.intent('item.selected', (conv, params, option) => {
  /*
  Helper for carousel - reacting to item selection.
  Related: https://developers.google.com/actions/assistant/helpers#getting_the_results_of_the_helper_1
  Get & compare the user's selections to each of the item's keys
  The param is set to the index when looping over the results to create the addItems contents.
  */
  const retrieved_list_body = conv.contexts.get('tag_list').parameters['list_body'];

  let selected_list_item; // Where we'll store the JSON details of the clicked item!

  conv.data.fallbackCount = 0; // Required for tracking fallback attempts!
  const possible_parameters = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15', '16', '17', '18', '19', '20', '21', '22', '23', '24', '25', '26', '27', '28', '29'];

  if (possible_parameters.includes(option)) {
    // Item within list clicked! Follow up immediately with the browse carousel!
    //console.warn(`item.selected: ${conv.contexts.get('list_body').parameters[option]} && ${retrieved_list_body[option]}`)
    //let target_topic = (retrieved_list_body[option].title).replace("🐳 ","");
    //console.warn(`TRIGGERED A! '${(retrieved_list_body[option].title).replace("🐳 ","")}'`);
    //conv.followup('get_topic_browse_carousel', {'allowed_topics': (retrieved_list_body[option].title).replace("🐳 ",""), 'sort_target': 'trending'});
    return show_carousel(conv, (retrieved_list_body[option].title).replace("🐳 ",""), 'trending');
  } else {
    // They somehow clicked on something not in the carousel, abandon ship!
    //console.warn(`item.selected: ${conv.contexts.get('list_body').parameters[option]} && ${retrieved_list_body[option]}`)
    console.log(`User clicked unknown item! ${option}`);
    conv.followup('Tag_List.fallback');
  }

});

app.intent('Tag_List.fallback', (conv) => {
  /*
  Fallback function for the voting mechanisms!
  Change the CAROUSEL_FALLBACK contents if you want different responses.
  */
    let CAROUSEL_FALLBACK_DATA = [
      "Sorry, which whaleshares tag was that?",
      "I didn't catch that. Could you repeat your whaleshares tag selection?",
    ];

    if (typeof(conv.contexts.get('tag_list')) !== "undefined") {
      if ((!(conv.data).hasOwnProperty('fallbackCount')) || (typeof(conv.data.fallbackCount) === "undefined")) {
        // Checking that the fallbackcount conv data exists
        conv.data.fallbackCount = 0;
      }

      if (conv.data.fallbackCount >= 2) {
        // The user failed too many times
        return conv.close("Unfortunately, Curate Mate was unable to understand user input. Sorry for the inconvenience, let's try again later though? Goodbye.");
      } else {
        /*
          Displaying carousel fallback & forwarding contexts in case of subsequent carousel fallbacks
        */
        const textToSpeech = `<speak>${CAROUSEL_FALLBACK_DATA[conv.data.fallbackCount]}</speak>`;
        const textToDisplay = CAROUSEL_FALLBACK_DATA[conv.data.fallbackCount];

        conv.data.fallbackCount++; // Iterate the fallback counter

        return conv.ask(
          new SimpleResponse({
            speech: textToSpeech,
            text: textToDisplay
          }),
          new List({
            title: 'Trending Whaleshares tags',
            items: conv.contexts.get('tag_list').parameters['list_body']
          }),
          new Suggestions('📑 Help', `🚪 Quit`)
        );

      }
    } else {
      /*
       Shouldn't occur, but better safe than sorry!
      */
      return handle_no_contexts(conv, 'Tag_List.fallback');
    }
});

function handle_no_contexts (conv, source_name) {
  /*
    The purpose of this function is to handle situations where a context was required but not present within the user's device.
    Hopefully this won't happen as much in the future..
  */
  console.log(`handled_no_contexts: ${source_name}`);
  conv.data.fallbackCount = 0; // Required for tracking fallback attempts!

  const fallback_messages = [
    "Sorry, what was that?",
    "I didn't catch that, what do you want movie mediator to do for you?"
  ];

  const suggestions = [`🐋 WLS Tag List`, '🆘 Help', `🚪 Quit`];

  const textToSpeech = `<speak>` +
    `Sorry, our last chat session expired. <break time="0.5s" /> ` +
    `What would you like to do next? <break time="0.25s" /> ` +
    `</speak>`;

  const textToDisplay = `Sorry, our last chat session expired.\n What would you like to do next?`;

  return conv.ask(
    new SimpleResponse({
      speech: textToSpeech,
      text: textToDisplay
    }),
    new Suggestions(suggestions)
  );
}

function get_content (current_author, current_permalink) {
  /*
    Seperate function for safely retrieving contnet within a loop
  */
  return new Promise((resolve, reject) => {
    wls.api.getContent(current_author, current_permalink, function(err, result) {
      if (err || !result) {
        return reject(new Error('Failed to retrieve content!'));
      } else {
        return resolve(result);
      }
    });
  });
}

function generate_individual_item_contents(input_list_item) {
  /*
    Given a 'current_target', attempt to retrieve post contents!
  */
  return new Promise((resolve, reject) => {
    if (typeof(input_list_item) === "undefined") {
      // Not good! Invalid item contents!
      let respond_with_undefined; // undefined
      return resolve(respond_with_undefined);
    } else {
      // Good to go!
      const current_author = input_list_item.result_author;
      const current_permalink = input_list_item.result_permlink;

      return get_content(current_author, current_permalink)
      .then(result => {
        const result_contents = {"children": result.children, "net_votes": result.net_votes, "total_payout_value": result.total_payout_value, "total_pending_payout_value":result.total_pending_payout_value};
        return resolve(result_contents);
      })
      .catch(error_message => {
        console.warn(`Failure: ${error_message}`);
      });
    }

  });
}

function show_carousel (conv, allowed_topics, sort_target) {
  /*
    Generic show_carousel!
  */
  return get_wls_results(allowed_topics, sort_target)
  .then(wls_results => {
    if ((typeof(wls_results) !== 'undefined') && wls_results.length >= 3) {
      //console.warn(`Passed A: ${typeof(wls_results)}, ${wls_results.length}`);
      return Promise.all(
        [
          wls_results,
          parse_wls_results(wls_results)
        ]
      );
    } else {
      // FALLBACK!
      const fallback_messages = [
        "Sorry, that topic doesn't have sufficient results, try another?",
        "Sorry again, I couldn't find any content for that topic, please provide another topic or try viewing the 'WLS Tag List' for help."
      ];
      const suggestions = [`🐋 WLS Tag List`, '🆘 Help', '🚪 Quit'];
      store_fallback_response(conv, fallback_messages, suggestions);
      return genericFallback(conv, `show_carousel`);
    }
  })
  .then(parsed_results => {
    // Run in sequence so that we have the required data to generate a browsing carousel with!
    //console.warn(`Passed B`);
    return Promise.all(
      [
        parsed_results[0], // original wls_results
        parsed_results[1], // parsed_results
        generate_individual_item_contents(parsed_results[1][0]),
        generate_individual_item_contents(parsed_results[1][1]),
        generate_individual_item_contents(parsed_results[1][2]),
        generate_individual_item_contents(parsed_results[1][3]),
        generate_individual_item_contents(parsed_results[1][4]),
        generate_individual_item_contents(parsed_results[1][5]),
        generate_individual_item_contents(parsed_results[1][6]),
        generate_individual_item_contents(parsed_results[1][7]),
        generate_individual_item_contents(parsed_results[1][8]),
        generate_individual_item_contents(parsed_results[1][9])
      ]
    );
  })
  .then(for_generating_carousel => {
    // Run in sequence so that we have the required data to generate a browsing carousel with!
    const post_metadata = [for_generating_carousel[2], for_generating_carousel[3], for_generating_carousel[4], for_generating_carousel[5], for_generating_carousel[6], for_generating_carousel[7], for_generating_carousel[8], for_generating_carousel[9], for_generating_carousel[10], for_generating_carousel[11]];
    //console.warn(`Passed C: ${JSON.stringify(post_metadata)}`);
    return Promise.all(
      [
        for_generating_carousel[0], // original wls_results
        for_generating_carousel[1], // parsed_results
        generate_browsing_carousel(for_generating_carousel[1], post_metadata) // Generating the browsing carousel
      ]
    );
  })
  .then(browsing_carousel_items => {
    // We've got our carousel, let's generate the view now!
    //console.warn(`Passed D ${browsing_carousel_items[2].length}`);

    if (browsing_carousel_items[2].length > 2) {
      // Sufficient list items to present the user!
      const fallback_messages = [
        "Sorry, what do you want to do next?",
        "I didn't catch that. What do you want to do next?"
      ];
      const suggestions = [`🐋 WLS Tag List`, '🆘 Help', '🚪 Quit'];
      store_fallback_response(conv, fallback_messages, suggestions);

      return conv.ask(
        new SimpleResponse({
          speech: `<speak>Here's your ${sort_target} '${allowed_topics}' content from the Whaleshares network!</speak>`,
          text: `Here's your ${sort_target} '${allowed_topics}' content from the Whaleshares network!`
        }),
        new SimpleResponse({
          speech: `<speak></speak>`,
          text: `⚠ This page will stay active for a while, remember to quit when done. 👍`
        }),
        new BrowseCarousel({items: browsing_carousel_items[2]}),
        new Suggestions([`🐋 WLS Tag List`, '🆘 Help', '🚪 Quit'])
      );
    } else {
      // Insufficient results!
      const fallback_messages = [
        "Sorry, that topic doesn't have sufficient results, try another?",
        "Sorry again, I couldn't find any content for that topic, please provide another topic or try viewing the 'WLS Tag List' for help."
      ];
      const suggestions = [`🐋 WLS Tag List`, '🆘 Help', '🚪 Quit'];
      store_fallback_response(conv, fallback_messages, suggestions);
      return genericFallback(conv, `show_carousel`);
    }
  })
  .catch(error_message => {
    return catch_error(conv, error_message, 'get_topic_browse_carousel');
  });
}

app.intent('get_topic_browse_carousel', (conv, { allowed_topics, sort_target }) => {
  /*
    Providing the user a list of exchanges they can trade the currently selected token!
  */
  conv.data.fallbackCount = 0; // Required for tracking fallback attempts!
  conv.user.storage.last_intent_name = 'get_topic_browse_carousel';

  const fallback_messages = [
    "Sorry, what do you want to do next?",
    "I didn't catch that. What do you want to do next?"
  ];
  const suggestions = [`🐋 WLS Tag List`, '🆘 Help', '🚪 Quit'];
  store_fallback_response(conv, fallback_messages, suggestions);
  store_timestamp(conv);

  var target_topic; // The tag we want
  if (typeof(allowed_topics) !== 'undefined') {
    if (allowed_topics !== '') {
      target_topic = allowed_topics;
    } else {
      return genericFallback(conv, 'get_topic_browse_carousel');
    }
  }

  console.warn(`${target_topic} carousel built`);
  var default_sort_target = 'trending'; // By default let's show trending topics
  if (typeof(sort_target) !== 'undefined') {
    // The user provided a sort target
    const allowed_sort_targets = ["trending", "new"];
    if (allowed_sort_targets.includes(sort_target)) {
      // Valid sort target!
      default_sort_target = sort_target;
    }
  }

  return show_carousel(conv, target_topic, sort_target);
});

app.intent('explicit_topic_mention', (conv, { input_tags }) => {
  /*
    Providing the user a list of exchanges they can trade the currently selected token!
  */
  conv.data.fallbackCount = 0; // Required for tracking fallback attempts!
  conv.user.storage.last_intent_name = 'explicit_topic_mention';

  const fallback_messages = [
    "Sorry, what do you want to do next?",
    "I didn't catch that. What do you want to do next?"
  ];
  const suggestions = [`🐋 WLS Tag List`, '🆘 Help', '🚪 Quit'];
  store_fallback_response(conv, fallback_messages, suggestions);
  store_timestamp(conv);

  var target_topic; // The tag we want
  if (typeof(input_tags) !== 'undefined') {
    if (input_tags !== '') {
      // Expected outcome - input accepted.
      target_topic = input_tags;
    } else {
      // Somehow they didn't provide a tag?!
      return genericFallback(conv, 'explicit_topic_mention');
    }
  }

  //console.warn(`${target_topic} carousel explicitly built`);
  return show_carousel(conv, target_topic, 'trending');
});

app.catch((conv, error_message) => {
  /*
    Generic error catch
  */
  console.error(error_message);
  return catch_error(conv, error_message, 'Generic_Error');
});

exports.WLS_BOT_STAGING = functions.https.onRequest(app);
